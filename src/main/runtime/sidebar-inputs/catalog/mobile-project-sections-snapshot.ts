import { isDeepStrictEqual } from 'node:util'
import type {
  MobileProjectSectionCatalog,
  MobileProjectSectionsResult
} from '../../../../shared/sidebar-list/catalog/mobile-project-sections-contract'

// Retain the last catalog after window close; stale grouping is better than none.
let latestCatalog: MobileProjectSectionCatalog | null = null

/** Returns whether paired clients would now read a different catalog. */
export function publishMobileProjectSections(catalog: MobileProjectSectionCatalog): boolean {
  const changed = !isDeepStrictEqual(catalog, latestCatalog)
  latestCatalog = catalog
  return changed
}

export function readMobileProjectSections(): MobileProjectSectionsResult {
  return { catalog: latestCatalog }
}
