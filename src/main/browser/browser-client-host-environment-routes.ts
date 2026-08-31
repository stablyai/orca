import {
  registerBrowserClientDownloadRouter,
  type BrowserClientDownloadRouter
} from './browser-client-download-routing'
import {
  BrowserClientPageMetadataTransport,
  registerBrowserClientPageMetadataTransport
} from './browser-client-page-metadata-transport'

export type BrowserClientHostEnvironmentRoutes = {
  pageMetadata: BrowserClientPageMetadataTransport
  release(): void
}

/**
 * The lookups a client-host composition publishes under its environment id, and the one release
 * that retires them together.
 *
 * Why keyed by environment rather than process-wide: both resolve which lease owns a page, and a
 * single global would answer with whichever composition composed last — sending one runtime's
 * downloads and page metadata to another's host.
 */
export function registerBrowserClientHostEnvironmentRoutes(
  environmentId: string,
  downloadRouter: BrowserClientDownloadRouter,
  observeCurrentUrl?: (params: unknown) => void
): BrowserClientHostEnvironmentRoutes {
  const pageMetadata = new BrowserClientPageMetadataTransport(observeCurrentUrl)
  const releases = [
    registerBrowserClientDownloadRouter(environmentId, downloadRouter),
    registerBrowserClientPageMetadataTransport(environmentId, pageMetadata)
  ]
  return {
    pageMetadata,
    release: () => {
      for (const release of releases) {
        release()
      }
    }
  }
}
