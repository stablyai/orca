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

/** Scope routes by environment so downloads and metadata reach the owning runtime. */
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
