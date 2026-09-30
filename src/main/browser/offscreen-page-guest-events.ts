import type { WebContents } from 'electron'
import type {
  OffscreenPageGuestEvent,
  OffscreenPageGuestState
} from '../../shared/offscreen-page-protocol'

export const OFFSCREEN_PAGE_EVENT_CHANNEL = 'offscreen-page:event'

export function readOffscreenPageGuestState(contents: WebContents): OffscreenPageGuestState {
  return {
    url: contents.getURL(),
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    isLoading: contents.isLoading(),
    zoomLevel: contents.getZoomLevel()
  }
}

/**
 * Re-emits the page's WebContents events in the shape a <webview> element fires them, each with a
 * fresh state snapshot, so the renderer element can answer webview's synchronous getters.
 * Returns the unsubscribe function.
 */
export function forwardOffscreenPageGuestEvents(
  contents: WebContents,
  emit: (event: OffscreenPageGuestEvent) => void
): () => void {
  const send = (type: OffscreenPageGuestEvent['type'], detail: Record<string, unknown> = {}) => {
    if (!contents.isDestroyed()) {
      emit({ type, detail, state: readOffscreenPageGuestState(contents) })
    }
  }
  const handlers: [string, (...args: never[]) => void][] = [
    ['dom-ready', () => send('dom-ready')],
    ['did-start-loading', () => send('did-start-loading')],
    ['did-stop-loading', () => send('did-stop-loading')],
    [
      'did-start-navigation',
      (details: { url: string; isInPlace: boolean; isMainFrame: boolean }) =>
        send('did-start-navigation', pickNavigation(details))
    ],
    [
      'did-redirect-navigation',
      (details: { url: string; isInPlace: boolean; isMainFrame: boolean }) =>
        send('did-redirect-navigation', pickNavigation(details))
    ],
    [
      'did-frame-navigate',
      (_e: unknown, url: string, _code: number, _status: string, isMainFrame: boolean) => {
        // Why: <webview> fires load-commit for every committed frame navigation; WebContents has no such event.
        send('load-commit', { url, isMainFrame })
        if (isMainFrame) {
          send('did-navigate', { url })
        }
      }
    ],
    [
      'did-navigate-in-page',
      (_e: unknown, url: string, isMainFrame: boolean) => {
        send('load-commit', { url, isMainFrame })
        send('did-navigate-in-page', { url, isMainFrame })
      }
    ],
    ['page-title-updated', (_e: unknown, title: string) => send('page-title-updated', { title })],
    [
      'page-favicon-updated',
      (_e: unknown, favicons: string[]) => send('page-favicon-updated', { favicons })
    ],
    [
      'did-fail-load',
      (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => send('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame })
    ],
    [
      'console-message',
      (details: { message: string; level: string }) =>
        send('console-message', { message: details.message, level: details.level })
    ],
    [
      'found-in-page',
      (_e: unknown, result: { activeMatchOrdinal: number; matches: number }) =>
        send('found-in-page', {
          result: { activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches }
        })
    ],
    [
      'render-process-gone',
      (_e: unknown, details: { reason: string; exitCode: number }) =>
        send('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
    ]
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each listener's parameters match the Electron event named beside it; WebContents' overloads can't be expressed over a heterogeneous table.
  const target = contents as unknown as {
    on(event: string, listener: (...args: never[]) => void): void
    off(event: string, listener: (...args: never[]) => void): void
  }
  for (const [event, handler] of handlers) {
    target.on(event, handler)
  }
  return () => {
    for (const [event, handler] of handlers) {
      target.off(event, handler)
    }
  }
}

function pickNavigation(details: { url: string; isInPlace: boolean; isMainFrame: boolean }) {
  return { url: details.url, isInPlace: details.isInPlace, isMainFrame: details.isMainFrame }
}
