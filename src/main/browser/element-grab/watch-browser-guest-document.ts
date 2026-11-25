import {
  isBrowserGuestViewportMessage,
  type BrowserGuestDocumentEvent
} from '../../../shared/browser/annotations/browser-guest-document-event'

// Scroll reports arrive per frame; a remote viewer needs only the newest per flush.
const VIEWPORT_FLUSH_MS = 33

/** Relays a guest's document lifecycle and viewport reports until the viewer leaves or the guest dies. */
export function watchBrowserGuestDocument(
  guest: Electron.WebContents,
  emit: (event: BrowserGuestDocumentEvent) => void,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise<void>((resolve) => {
    let pendingViewport: string | null = null
    let viewportTimer: ReturnType<typeof setTimeout> | null = null
    const flushViewport = (): void => {
      viewportTimer = null
      if (pendingViewport !== null) {
        emit({ type: 'viewport', message: pendingViewport })
        pendingViewport = null
      }
    }
    // Page scripts can print the prefix too; the viewer checks the bridge token before trusting it.
    const onConsoleMessage = (details: { message?: unknown }): void => {
      if (!isBrowserGuestViewportMessage(details.message)) {
        return
      }
      pendingViewport = details.message
      viewportTimer ??= setTimeout(flushViewport, VIEWPORT_FLUSH_MS)
    }
    const onStartNavigation = ({
      isSameDocument,
      isMainFrame
    }: Electron.WebContentsDidStartNavigationEventParams): void => {
      if (isMainFrame && !isSameDocument) {
        // A report from the departing document would place the next card wrongly.
        pendingViewport = null
        emit({ type: 'documentStart' })
      }
    }
    const onNavigate = (_event: unknown, url: string): void => emit({ type: 'navigated', url })
    const onNavigateInPage = (_event: unknown, url: string, isMainFrame: boolean): void => {
      if (isMainFrame) {
        emit({ type: 'navigated', url })
      }
    }
    const onDomReady = (): void => emit({ type: 'domReady' })
    // A replaced guest took its document with it; anything picked there is gone.
    const onDestroyed = (): void => {
      emit({ type: 'documentStart' })
      stop()
    }

    const stop = (): void => {
      if (viewportTimer) {
        clearTimeout(viewportTimer)
      }
      signal?.removeEventListener('abort', stop)
      if (!guest.isDestroyed()) {
        guest.off('console-message', onConsoleMessage)
        guest.off('did-start-navigation', onStartNavigation)
        guest.off('did-navigate', onNavigate)
        guest.off('did-navigate-in-page', onNavigateInPage)
        guest.off('dom-ready', onDomReady)
        guest.off('destroyed', onDestroyed)
      }
      resolve()
    }
    if (signal?.aborted || guest.isDestroyed()) {
      resolve()
      return
    }
    guest.on('console-message', onConsoleMessage)
    guest.on('did-start-navigation', onStartNavigation)
    guest.on('did-navigate', onNavigate)
    guest.on('did-navigate-in-page', onNavigateInPage)
    guest.on('dom-ready', onDomReady)
    guest.once('destroyed', onDestroyed)
    signal?.addEventListener('abort', stop, { once: true })
    emit({ type: 'navigated', url: guest.getURL() })
    if (!guest.isLoadingMainFrame()) {
      emit({ type: 'domReady' })
    }
  })
}
