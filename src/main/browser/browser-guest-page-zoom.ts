import type { WebContents } from 'electron'
import {
  applyBrowserPageZoomLevel,
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
} from '../../shared/browser-page-zoom'

const ZOOM_REASSERT_EVENTS = ['dom-ready', 'did-finish-load'] as const

export function applyRemoteBrowserGuestPageZoom(guest: WebContents): number | null {
  return applyBrowserPageZoomLevel(guest, DEFAULT_BROWSER_PAGE_ZOOM_LEVEL)
}

export function attachRemoteBrowserGuestPageZoomReassert(guest: WebContents): () => void {
  const apply = (): void => {
    applyRemoteBrowserGuestPageZoom(guest)
  }
  apply()
  if (typeof guest.on !== 'function' || typeof guest.off !== 'function') {
    return () => {}
  }
  for (const event of ZOOM_REASSERT_EVENTS) {
    guest.on(event, apply)
  }
  return () => {
    for (const event of ZOOM_REASSERT_EVENTS) {
      guest.off(event, apply)
    }
  }
}
