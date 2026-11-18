import {
  isOfficialMarketplaceGitSource,
  isSameGitRepository
} from '../../shared/plugins/catalog/plugin-marketplace'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../shared/plugins/catalog/plugin-install-link'
import {
  isZotzCloudFeatureAllowed,
  ZOTZ_CLOUD_DISABLED_MESSAGE
} from '../../shared/zotz/zotz-network-policy'

let readUserOptIn: () => boolean = () => false

/** Startup binds the zotzOrcaPluginCatalogEnabled setting; until then Orca's catalogs stay off. */
export function bindZotzPluginCatalogOptIn(read: () => boolean): void {
  readUserOptIn = read
}

export function isZotzPluginCatalogAllowed(): boolean {
  // E2E drivers run upstream plugin suites, which install from Orca's catalogs.
  return (
    isZotzCloudFeatureAllowed('plugin-catalog') ||
    readUserOptIn() ||
    Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  )
}

/** Runs a seed of Orca's catalogs only when Zotz allows it; otherwise rejects without network. */
export function guardZotzPluginCatalogSeed<T>(seed: () => Promise<T>): Promise<T> {
  return isZotzPluginCatalogAllowed()
    ? seed()
    : Promise.reject(new Error(ZOTZ_CLOUD_DISABLED_MESSAGE))
}

// Also covers sources seeded before Zotz blocked Orca's catalogs.
export function assertZotzMarketplaceAllowed(url: string): void {
  const orcaCatalog =
    isOfficialMarketplaceGitSource(url) ||
    isSameGitRepository(url, COMMUNITY_MARKETPLACE_GIT_SOURCE.url)
  if (orcaCatalog && !isZotzPluginCatalogAllowed()) {
    throw new Error(ZOTZ_CLOUD_DISABLED_MESSAGE)
  }
}
