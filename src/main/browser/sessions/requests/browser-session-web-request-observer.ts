/**
 * Electron allows one session.webRequest listener per event, and any listener at all turns off
 * extensions' own chrome.webRequest for the whole session (electron_browser_client.cc
 * WillCreateURLLoaderFactory checks HasListener). Orca's handlers report what they see here so
 * browser extensions can still observe requests (browser-extension-web-request.ts).
 */

export type ObservedWebRequestEvent =
  | 'onBeforeRequest'
  | 'onBeforeSendHeaders'
  | 'onSendHeaders'
  | 'onHeadersReceived'
  | 'onResponseStarted'
  | 'onBeforeRedirect'
  | 'onCompleted'
  | 'onErrorOccurred'

/** The union of Electron's per-event details; each event fills in its own fields. */
export type ObservedWebRequestDetails = {
  id: number
  url: string
  method: string
  webContentsId?: number
  frame?: Electron.WebFrameMain | null
  resourceType: string
  initiatorOrigin?: string
  timestamp: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
  statusCode?: number
  statusLine?: string
  fromCache?: boolean
  ip?: string
  redirectURL?: string
  error?: string
}

type Observer = (
  session: Electron.Session,
  event: ObservedWebRequestEvent,
  details: ObservedWebRequestDetails
) => void

let observer: Observer | null = null
const guestObservers = new Map<number, Set<Observer>>()

export function observeBrowserGuestRequests(webContentsId: number, next: Observer): () => void {
  let observers = guestObservers.get(webContentsId)
  if (!observers) {
    observers = new Set()
    guestObservers.set(webContentsId, observers)
  }
  observers.add(next)
  return () => {
    const current = guestObservers.get(webContentsId)
    current?.delete(next)
    if (current?.size === 0) {
      guestObservers.delete(webContentsId)
    }
  }
}

export function setBrowserSessionWebRequestObserver(next: Observer): void {
  observer = next
}

/** Called by every Orca session.webRequest handler on browser sessions; must stay cheap. */
export function reportBrowserSessionWebRequest(
  session: Electron.Session,
  event: ObservedWebRequestEvent,
  details: ObservedWebRequestDetails
): void {
  if (details.webContentsId !== undefined) {
    const observers = guestObservers.get(details.webContentsId)
    if (observers) {
      for (const guestObserver of observers) {
        try {
          guestObserver(session, event, details)
        } catch (error) {
          console.warn('[browser] guest web request observer failed:', error)
        }
      }
    }
  }
  if (!observer) {
    return
  }
  try {
    observer(session, event, details)
  } catch (error) {
    console.warn('[browser] web request observer failed:', error)
  }
}
