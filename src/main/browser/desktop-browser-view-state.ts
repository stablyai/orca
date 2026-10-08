import type {
  DesktopBrowserViewEvent,
  DesktopBrowserViewState
} from '../../shared/desktop-browser-view-protocol'
import type { BrowserLoadError } from '../../shared/browser-workspace-types'
import type { DesktopOwnedBrowserViewRecord } from './desktop-owned-browser-view-admission'
import { observeDesktopBrowserViewDocument } from './desktop-browser-view-document'
import {
  browserNavigationLeavesFaviconOrigin,
  pickDisplayableFaviconUrl
} from '../../shared/browser-favicon-url'

export function observeDesktopBrowserView(
  record: DesktopOwnedBrowserViewRecord,
  publish: (event: DesktopBrowserViewEvent) => void,
  onDestroyed: () => void
): { read: () => DesktopBrowserViewState; dispose: () => void } {
  const guest = record.webContents
  const identity = { browserPageId: record.browserPageId, generation: record.generation }
  let faviconUrl: string | null = null
  let loadError: BrowserLoadError | null = null
  let revision = 0
  const read = (): DesktopBrowserViewState => ({
    ...identity,
    revision: ++revision,
    url: guest.getURL(),
    title: guest.getTitle(),
    loading: guest.isLoading(),
    canGoBack: guest.navigationHistory.canGoBack(),
    canGoForward: guest.navigationHistory.canGoForward(),
    faviconUrl,
    loadError,
    zoomLevel: guest.getZoomLevel(),
    focused: guest.isFocused()
  })
  const changed = (): void => {
    if (!guest.isDestroyed()) {
      publish({ kind: 'state', state: read() })
    }
  }
  const loaded = (): void => {
    loadError = null
    changed()
  }
  const failed = (
    _event: Electron.Event,
    code: number,
    description: string,
    validatedUrl: string,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame && code !== -3) {
      loadError = { code, description, validatedUrl }
      changed()
    }
  }
  const faviconChanged = (_event: Electron.Event, favicons: string[]): void => {
    faviconUrl = pickDisplayableFaviconUrl(favicons)
    changed()
  }
  const navigationStarted = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (
      event.isMainFrame &&
      !event.isSameDocument &&
      browserNavigationLeavesFaviconOrigin(guest.getURL(), event.url)
    ) {
      faviconUrl = null
      changed()
    }
  }
  const found = (_event: Electron.Event, result: Electron.FoundInPageResult): void => {
    publish({ kind: 'found-in-page', ...identity, result })
  }
  const destroyed = (): void => {
    publish({ kind: 'destroyed', ...identity })
    onDestroyed()
  }
  guest.on('did-start-loading', changed)
  guest.on('did-start-navigation', navigationStarted)
  guest.on('did-redirect-navigation', navigationStarted)
  guest.on('did-stop-loading', changed)
  guest.on('did-navigate', loaded)
  guest.on('did-navigate-in-page', changed)
  guest.on('page-title-updated', changed)
  guest.on('page-favicon-updated', faviconChanged)
  guest.on('did-fail-load', failed)
  guest.on('focus', changed)
  guest.on('blur', changed)
  guest.on('found-in-page', found)
  guest.once('destroyed', destroyed)
  // Consumers must read the committed state before handling its document event.
  const disposeDocument = observeDesktopBrowserViewDocument(record, publish)
  return {
    read,
    dispose: () => {
      disposeDocument()
      guest.removeListener('did-start-loading', changed)
      guest.removeListener('did-start-navigation', navigationStarted)
      guest.removeListener('did-redirect-navigation', navigationStarted)
      guest.removeListener('did-stop-loading', changed)
      guest.removeListener('did-navigate', loaded)
      guest.removeListener('did-navigate-in-page', changed)
      guest.removeListener('page-title-updated', changed)
      guest.removeListener('page-favicon-updated', faviconChanged)
      guest.removeListener('did-fail-load', failed)
      guest.removeListener('focus', changed)
      guest.removeListener('blur', changed)
      guest.removeListener('found-in-page', found)
      guest.removeListener('destroyed', destroyed)
    }
  }
}
