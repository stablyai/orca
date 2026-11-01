import {
  isBrowserSiteColorScheme,
  type BrowserSiteDisplay
} from '../../shared/browser-site-display'
import { normalizeBrowserPageZoomLevel } from '../../shared/browser-page-zoom'
import { createBrowserProfileSiteStore } from './browser-profile-site-store'

function parseSiteDisplay(value: unknown): BrowserSiteDisplay | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const display: BrowserSiteDisplay = {}
  if ('zoomLevel' in value && typeof value.zoomLevel === 'number') {
    display.zoomLevel = normalizeBrowserPageZoomLevel(value.zoomLevel)
  }
  if ('colorScheme' in value && isBrowserSiteColorScheme(value.colorScheme)) {
    display.colorScheme = value.colorScheme
  }
  return Object.keys(display).length > 0 ? display : null
}

const store = createBrowserProfileSiteStore({
  fileName: 'browser-site-display.json',
  description: 'site zoom and appearance',
  parseEntry: parseSiteDisplay
})

export function configureBrowserSiteDisplayStore(profileDirectory: string): void {
  store.configure(profileDirectory)
}

export function getBrowserSiteDisplay(profileId: string, site: string): BrowserSiteDisplay {
  return store.get(profileId, site) ?? {}
}

/** Undefined fields are forgotten; a site left with nothing is dropped. */
export function updateBrowserSiteDisplay(
  profileId: string,
  site: string,
  update: BrowserSiteDisplay
): void {
  store.set(profileId, site, parseSiteDisplay({ ...store.get(profileId, site), ...update }))
}

export function forgetBrowserSiteDisplay(profileId: string): void {
  store.forget(profileId)
}
