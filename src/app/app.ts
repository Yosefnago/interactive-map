import {
  Component, OnInit, AfterViewInit, OnDestroy,
  HostListener, ChangeDetectorRef, NgZone, ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DATA_LIST, PopUpData, MacroAlgaeInfo, MicroAlgaeInfo, CyanobacteriaInfo } from './app.data';
import * as L from 'leaflet';


const REGION_BOUNDS: L.LatLngBoundsExpression = [[0, -20], [75, 100]];

type AlgaeItem = MacroAlgaeInfo | MicroAlgaeInfo;
type FilteredResult = { country: string; type: string; name: string };
type PartnerPopup = PopUpData & { 
  macroAlgae: MacroAlgaeInfo[]; 
  microAlgae: MicroAlgaeInfo[]; 
  cyanobacteriaAlgae: CyanobacteriaInfo[] 
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnInit, AfterViewInit, OnDestroy {

  private map!: L.Map;
  private cachedGeoJson: any = null;
  private markerGroup!: any;
  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private partnerAlgaeCache = new Map<PopUpData, AlgaeItem[]>();

  public sortedPartners: PopUpData[] = [];
  public popupPartner: PartnerPopup | null = null;
  public selectedAlgae: AlgaeItem | null = null;
  public selectedAlgaeType = '';
  public filterOpen = false;
  public countries: string[] = [];
  public properties: string[] = [];
  public filteredResults: FilteredResult[] = [];
  public selectedFilters = { country: '', property: '' };
  public filteredPartners: PopUpData[] = [];

  constructor(private cdr: ChangeDetectorRef, private zone: NgZone) { }

  ngOnInit(): void {
    this.sortedPartners = [...DATA_LIST].sort((a, b) => 
      (a.name || '').localeCompare(b.name || '')
    );

    this.sortedPartners.forEach(p => {
      this.partnerAlgaeCache.set(p, [...(p.macroAlgae ?? []), ...(p.microAlgae ?? []), ...(p.cyanobacteriaAlgae ?? [])]);
    });

    this.filteredPartners = [...this.sortedPartners];
    this.extractFilterOptions();
  }

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      const script = document.createElement('script');
      script.src = 'assets/leaflet.markercluster.js';
      script.onload = () => {
        this.initMap();
        requestAnimationFrame(() => this.map.invalidateSize());
      };
      document.head.appendChild(script);
    });
  }

  ngOnDestroy(): void {
    if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
    this.map?.remove();
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
    this.zone.runOutsideAngular(() => {
      this.resizeTimeout = setTimeout(() => this.map?.invalidateSize(), 150);
    });
  }

  private extractFilterOptions(): void {
    const countrySet = new Set<string>();
    const propertySet = new Set<string>();

    DATA_LIST.forEach(p => {
      const allAlgae = this.partnerAlgaeCache.get(p) ?? [];
      allAlgae.forEach(a => {
        if (a.country) countrySet.add(a.country);
        a.properties?.forEach(prop => propertySet.add(prop));
      });
    });

    this.countries = Array.from(countrySet).sort();
    this.properties = Array.from(propertySet).sort();
  }

  private initMap(): void {
    const customColor = '#57ADAB';

    this.map = L.map('map', {
      renderer: L.canvas({ tolerance: 3 }),
      minZoom: 3.5, 
      maxZoom: 8,
      zoomDelta: 1,
      zoomSnap: 0,
      zoomControl: false,
      maxBounds: REGION_BOUNDS,
      maxBoundsViscosity: 1.0,
    }).fitBounds(REGION_BOUNDS);

    delete (L.Icon.Default.prototype as any)._getIconUrl;

    const myIcon = L.divIcon({
      className: 'custom-marker', 
      html: `<svg width="16" height="26" viewBox="0 0 25 41" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.5 0C5.596 0 0 5.596 0 12.5C0 21.875 12.5 41 12.5 41C12.5 41 25 21.875 25 12.5C25 5.596 19.404 0 12.5 0Z" fill="${customColor}"/>
              <circle cx="12.5" cy="12.5" r="4" fill="white"/>
            </svg>`,
      iconSize: [16, 26],   
      iconAnchor: [8, 26], 
      popupAnchor: [1, -26]
    });
    L.Marker.prototype.options.icon = myIcon;

  
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
      crossOrigin: true
    }).addTo(this.map);
    
    this.markerGroup = (window as any).L.markerClusterGroup({
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      maxClusterRadius: 20,
      
      iconCreateFunction: (cluster: any) => {
        return L.divIcon({
          className: 'custom-cluster-marker',
          html: `<svg width="16" height="26" viewBox="0 0 25 41" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12.5 0C5.596 0 0 5.596 0 12.5C0 21.875 12.5 41 12.5 41C12.5 41 25 21.875 25 12.5C25 5.596 19.404 0 12.5 0Z" fill="${customColor}"/>
                  <circle cx="12.5" cy="12.5" r="4" fill="white"/>
                </svg>`,
          iconSize: [16, 26],   
          iconAnchor: [8, 26], 
          popupAnchor: [1, -26]
        });
      }
    });

    this.markerGroup.addTo(this.map);
    
    this.loadCountries();
    this.renderMarkers();
  }

  renderMarkers(): void {
  this.zone.runOutsideAngular(() => {
    if (!this.markerGroup) return;
    this.markerGroup.clearLayers();
    
    const newResults: FilteredResult[] = [];
    const markers: L.Marker[] = [];
    const currentFiltered: PopUpData[] = []; 
    const isAnyFilterActive = !!(this.selectedFilters.country || this.selectedFilters.property);

    DATA_LIST.forEach(partner => {
      const allAlgae = this.partnerAlgaeCache.get(partner) || [];

      const matchesCountry = !this.selectedFilters.country ||
        allAlgae.some(a => a.country === this.selectedFilters.country);
      
      const matchesProperty = !this.selectedFilters.property ||
        allAlgae.some(a => a.properties && a.properties.includes(this.selectedFilters.property));

      if (!matchesCountry || !matchesProperty) return;

      currentFiltered.push(partner);

      const marker = L.marker(partner.coords as L.LatLngExpression);
      marker.on('click', () => this.zone.run(() => this.onPinClick(partner)));
      markers.push(marker);

      if (isAnyFilterActive) {
        allAlgae.forEach(algae => {
          const mCountry = !this.selectedFilters.country || algae.country === this.selectedFilters.country;
          const mProp = !this.selectedFilters.property || (algae.properties && algae.properties.includes(this.selectedFilters.property));
          if (mCountry && mProp) {
            newResults.push({ country: algae.country, type: algae.type, name: algae.name });
          }
        });
      }
    });

    markers.forEach(m => this.markerGroup.addLayer(m));

    this.zone.run(() => {
      this.filteredPartners = currentFiltered.sort((a, b) => 
        (a.name || '').localeCompare(b.name || '')
      );

      this.filteredResults = newResults;
      this.cdr.markForCheck();
    });
  });
}
  resetZoom(): void {
    this.zone.runOutsideAngular(() => {
      this.map.once('moveend', () => {
        this.renderMarkers();
      });
      this.map.flyToBounds(REGION_BOUNDS, { duration: 0.6 });
    });
  }

  private loadCountries(): void {
    if (this.cachedGeoJson) {
      this.renderGeoJson(this.cachedGeoJson);
      return;
    }
    this.zone.runOutsideAngular(() => {
      fetch('assets/map.geojson')
        .then(r => r.json())
        .then(data => {
          this.cachedGeoJson = data;
          this.renderGeoJson(data);
        });
    });
  }

  private renderGeoJson(data: any): void {
    L.geoJSON(data, {
      interactive: false,
      filter: f => f.geometry.type !== 'Point',
      style: { color: '#53B5A5', fillColor: '#53B5A5', weight: 1, fillOpacity: 0.2 },
      pointToLayer: (_f, latlng) => L.marker(latlng)
    }).addTo(this.map);
  }

  onPinClick(popData: PopUpData): void {
    this.popupPartner = {
      ...popData,
      macroAlgae: (popData as any).macroAlgae ?? [],
      microAlgae: (popData as any).microAlgae ?? [],
      cyanobacteriaAlgae: (popData as any).cyanobacteriaAlgae ?? [],
    } as PartnerPopup;
    this.cdr.markForCheck(); 

    this.zone.runOutsideAngular(() => {
      setTimeout(() => {
        this.map.setView(popData.coords as L.LatLngExpression, 8, { animate: true });
      }, 50);
    });
  }

  closePopup(): void {
    this.popupPartner = null;
    this.selectedAlgae = null;
    this.selectedAlgaeType = '';
    this.cdr.markForCheck();
  }

  selectAlgae(algae: AlgaeItem): void {
    this.selectedAlgae = algae;
    this.cdr.markForCheck();
  }

  chossedAlgaeType(type: string): void {
    this.selectedAlgaeType = type;
    this.cdr.markForCheck();
  }

  goBack(): void {
    if (this.selectedAlgaeType !== '') {
      this.selectedAlgaeType = '';
      this.selectedAlgae = null;
    } else {
      this.closePopup();
      return; 
    }
    this.cdr.markForCheck();
  }

  applyFilter(type: 'country' | 'property', value: string): void {
    this.selectedFilters[type] = value;
    this.renderMarkers();
  }

  clearFilters(): void {
    this.selectedFilters = { country: '', property: '' };
    this.renderMarkers();
  }

  openFilter(): void {
    this.filterOpen = !this.filterOpen;
    this.cdr.markForCheck();
  }

  public getCurrentPartnerIndex(): number {
    return this.filteredPartners.findIndex(p => p.name === this.popupPartner?.name);
  }

  public nextPartner(): void {
    const currentIndex = this.getCurrentPartnerIndex();
    if (currentIndex === -1 || this.filteredPartners.length === 0) return;

    const nextIndex = (currentIndex + 1) % this.filteredPartners.length;
    
    this.selectedAlgae = null;
    this.selectedAlgaeType = '';
    
    this.onPinClick(this.filteredPartners[nextIndex]);
  }

  public previousPartner(): void {
    const currentIndex = this.getCurrentPartnerIndex();
    if (currentIndex === -1 || this.filteredPartners.length === 0) return;

    const prevIndex = (currentIndex - 1 + this.filteredPartners.length) % this.filteredPartners.length;
    
    this.selectedAlgae = null;
    this.selectedAlgaeType = '';

    this.onPinClick(this.filteredPartners[prevIndex]);
  }
}