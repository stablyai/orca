import type {
  MobileProjectSectionCatalog,
  MobileProjectSectionsResult
} from '../../shared/mobile-project-sections-contract'

// Retain the last catalog after window close; stale grouping is better than none.
let latestCatalog: MobileProjectSectionCatalog | null = null

export function publishMobileProjectSections(catalog: MobileProjectSectionCatalog): void {
  latestCatalog = catalog
}

export function readMobileProjectSections(): MobileProjectSectionsResult {
  return { catalog: latestCatalog }
}
