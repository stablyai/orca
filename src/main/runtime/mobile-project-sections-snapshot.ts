import type {
  MobileProjectSectionCatalog,
  MobileProjectSectionsResult
} from '../../shared/mobile-project-sections-contract'

// Why kept after the window closes: a stale sidebar catalog groups better than none.
let latestCatalog: MobileProjectSectionCatalog | null = null

/** The authoritative desktop window's sidebar catalog, as its runtime graph last carried it. */
export function publishMobileProjectSections(catalog: MobileProjectSectionCatalog): void {
  latestCatalog = catalog
}

export function readMobileProjectSections(): MobileProjectSectionsResult {
  return { catalog: latestCatalog }
}
