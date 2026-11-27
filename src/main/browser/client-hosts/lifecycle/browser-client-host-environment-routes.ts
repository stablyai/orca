import {
  registerBrowserClientDownloadRouter,
  type BrowserClientDownloadRouter
} from '../file-transfers/browser-client-download-routing'
import {
  BrowserClientPageMetadataTransport,
  registerBrowserClientPageMetadataTransport
} from '../../client-pages/renderer/browser-client-page-metadata-transport'
import { registerBrowserClientPageCookieJars } from '../../client-pages/lifecycle/browser-client-page-cookie-jars'
import type { BrowserClientPageCookieJar } from '../../client-pages/lifecycle/browser-client-page-retained-state'

export type BrowserClientHostEnvironmentRoutes = {
  pageMetadata: BrowserClientPageMetadataTransport
  release(): void
}

/** Scope routes by environment so downloads, metadata and cookie imports reach the owning runtime. */
export function registerBrowserClientHostEnvironmentRoutes(
  environmentId: string,
  downloadRouter: BrowserClientDownloadRouter,
  pageCookieJar: (browserPageId: string) => BrowserClientPageCookieJar | null,
  observeCurrentUrl?: (params: unknown) => void
): BrowserClientHostEnvironmentRoutes {
  const pageMetadata = new BrowserClientPageMetadataTransport(observeCurrentUrl)
  const releases = [
    registerBrowserClientDownloadRouter(environmentId, downloadRouter),
    registerBrowserClientPageMetadataTransport(environmentId, pageMetadata),
    registerBrowserClientPageCookieJars(environmentId, pageCookieJar)
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
