import type { Session } from 'electron'

type Listeners = {
  onBeforeRequest: (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void
  ) => void
  onBeforeSendHeaders: (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void
  ) => void
  onSendHeaders: (details: Electron.OnSendHeadersListenerDetails) => void
  onHeadersReceived: (
    details: Electron.OnHeadersReceivedListenerDetails,
    callback: (response: Electron.HeadersReceivedResponse) => void
  ) => void
  onResponseStarted: (details: Electron.OnResponseStartedListenerDetails) => void
  onBeforeRedirect: (details: Electron.OnBeforeRedirectListenerDetails) => void
  onCompleted: (details: Electron.OnCompletedListenerDetails) => void
  onErrorOccurred: (details: Electron.OnErrorOccurredListenerDetails) => void
}

export type BrowserSessionWebRequestEvent = keyof Listeners

type Install = (filterOrListener: unknown, listener?: unknown) => void

const holdersBySession = new WeakMap<Session, Map<BrowserSessionWebRequestEvent, symbol>>()

/**
 * The only installer of `session.webRequest` listeners on browser sessions. Electron keeps one
 * listener per event, so a second installer would silently replace the first; and while a session
 * has any listener, every page subresource request waits on main (Electron's URL loader gate).
 * Returns the release; omit `filter` to see every URL, as Electron does.
 */
export function holdBrowserSessionWebRequest<E extends BrowserSessionWebRequestEvent>(
  session: Session,
  event: E,
  listener: Listeners[E],
  filter?: Electron.WebRequestFilter
): () => void {
  let holders = holdersBySession.get(session)
  if (!holders) {
    holders = new Map()
    holdersBySession.set(session, holders)
  }
  if (holders.has(event)) {
    throw new Error(`browser session ${event} is already held`)
  }
  const hold = Symbol(event)
  holders.set(event, hold)
  const install = session.webRequest[event].bind(session.webRequest) as Install
  if (filter) {
    install(filter, listener)
  } else {
    install(listener)
  }
  return () => {
    if (holders.get(event) !== hold) {
      return
    }
    holders.delete(event)
    install(null)
  }
}
