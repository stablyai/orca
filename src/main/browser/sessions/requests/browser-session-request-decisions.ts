import {
  reportBrowserSessionWebRequest,
  type ObservedWebRequestDetails
} from './browser-session-web-request-observer'
import { holdBrowserSessionWebRequest } from './browser-session-web-request-owner'

/**
 * Electron allows one session.webRequest listener per event, so request decisions owned by other
 * layers (extension content blocking) run inside Orca's own handlers: the certificate guard's
 * onBeforeRequest, the user agent policy's onBeforeSendHeaders and the onHeadersReceived installed
 * here. Each hook is called only after Orca's own policy for that event has run.
 */
export type BrowserSessionRequestDecider = {
  /** Null lets the request through; a promise holds it until the decision is known. */
  beforeRequest: (
    session: Electron.Session,
    details: Electron.OnBeforeRequestListenerDetails
  ) => Electron.CallbackResponse | Promise<Electron.CallbackResponse> | null
  /** Returns the headers to send: `headers` itself, or a modified copy. */
  beforeSendHeaders: (
    session: Electron.Session,
    details: Electron.OnBeforeSendHeadersListenerDetails,
    headers: Record<string, string>
  ) => Record<string, string>
  headersReceived: (
    session: Electron.Session,
    details: Electron.OnHeadersReceivedListenerDetails
  ) => Electron.HeadersReceivedResponse | null
  requestFinished?: (
    session: Electron.Session,
    event: 'onCompleted' | 'onErrorOccurred',
    details: ObservedWebRequestDetails
  ) => void
  requestLifecycleStopped?: (session: Electron.Session) => void
}

let decider: BrowserSessionRequestDecider | null = null

export function setBrowserSessionRequestDecider(next: BrowserSessionRequestDecider | null): void {
  decider = next
}

function warn(event: string, error: unknown): void {
  console.warn(`[browser] request decision for ${event} failed:`, error)
}

const blockedMainFrameWatchers = new Map<number, (url: string) => void>()

/**
 * Calls `onBlocked` when the decider (an extension) cancels this webContents' main-frame load.
 * A webview guest then fails without committing an error page or emitting any load failure.
 */
export function watchDecisionBlockedMainFrames(
  webContentsId: number,
  onBlocked: (url: string) => void
): () => void {
  blockedMainFrameWatchers.set(webContentsId, onBlocked)
  return () => {
    if (blockedMainFrameWatchers.get(webContentsId) === onBlocked) {
      blockedMainFrameWatchers.delete(webContentsId)
    }
  }
}

function noteBlockedMainFrame(
  details: Electron.OnBeforeRequestListenerDetails,
  response: Electron.CallbackResponse
): void {
  if (
    response.cancel &&
    details.resourceType === 'mainFrame' &&
    details.webContentsId !== undefined
  ) {
    const onBlocked = blockedMainFrameWatchers.get(details.webContentsId)
    reportingBlockedRequestId = details.id
    try {
      onBlocked?.(details.url)
    } finally {
      reportingBlockedRequestId = null
    }
  }
}

let reportingBlockedRequestId: number | null = null

/** While the failure for an extension-blocked main frame is reported, that request's id. */
export function blockedMainFrameRequestBeingReported(): number | null {
  return reportingBlockedRequestId
}

/** Answers an onBeforeRequest that Orca's own policy let through. */
export function answerBrowserSessionBeforeRequest(
  session: Electron.Session,
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void
): void {
  const answer = (response: Electron.CallbackResponse): void => {
    noteBlockedMainFrame(details, response)
    callback(response)
  }
  let decision: ReturnType<BrowserSessionRequestDecider['beforeRequest']> = null
  try {
    decision = decider?.beforeRequest(session, details) ?? null
  } catch (error) {
    warn('onBeforeRequest', error)
  }
  if (decision === null) {
    callback({})
  } else if ('then' in decision) {
    decision.then(answer, (error: unknown) => {
      warn('onBeforeRequest', error)
      callback({})
    })
  } else {
    answer(decision)
  }
}

export function decideBrowserSessionRequestHeaders(
  session: Electron.Session,
  details: Electron.OnBeforeSendHeadersListenerDetails,
  headers: Record<string, string>
): Record<string, string> {
  try {
    return decider?.beforeSendHeaders(session, details, headers) ?? headers
  } catch (error) {
    warn('onBeforeSendHeaders', error)
    return headers
  }
}

const WEB_URLS = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
const releaseHeadersReceived = new WeakMap<Electron.Session, () => void>()
const releaseRequestLifecycle = new WeakMap<Electron.Session, () => void>()

/** Shared completion handlers also release enforcement state for cache hits and failed requests. */
export function installBrowserSessionRequestLifecycle(session: Electron.Session): void {
  if (releaseRequestLifecycle.has(session)) {
    return
  }
  const finished = (
    event: 'onCompleted' | 'onErrorOccurred',
    details: ObservedWebRequestDetails
  ): void => {
    reportBrowserSessionWebRequest(session, event, details)
    try {
      decider?.requestFinished?.(session, event, details)
    } catch (error) {
      warn(event, error)
    }
  }
  const releaseCompleted = holdBrowserSessionWebRequest(
    session,
    'onCompleted',
    (details) => finished('onCompleted', details),
    WEB_URLS
  )
  const releaseErrorOccurred = holdBrowserSessionWebRequest(
    session,
    'onErrorOccurred',
    (details) => finished('onErrorOccurred', details),
    WEB_URLS
  )
  releaseRequestLifecycle.set(session, () => {
    releaseCompleted()
    releaseErrorOccurred()
  })
}

export function removeBrowserSessionRequestLifecycle(session: Electron.Session): void {
  const release = releaseRequestLifecycle.get(session)
  if (release) {
    releaseRequestLifecycle.delete(session)
    release()
    decider?.requestLifecycleStopped?.(session)
  }
}

/**
 * The session's one onHeadersReceived, installed on first need (an extension that observes
 * webRequest, or content blocking that acts on responses) and removed when extensions turn off.
 */
export function installBrowserSessionHeadersReceived(session: Electron.Session): void {
  if (releaseHeadersReceived.has(session)) {
    return
  }
  releaseHeadersReceived.set(
    session,
    holdBrowserSessionWebRequest(
      session,
      'onHeadersReceived',
      (details, callback) => {
        reportBrowserSessionWebRequest(session, 'onHeadersReceived', details)
        let response: Electron.HeadersReceivedResponse | null = null
        try {
          response = decider?.headersReceived(session, details) ?? null
        } catch (error) {
          warn('onHeadersReceived', error)
        }
        callback(response ?? {})
      },
      WEB_URLS
    )
  )
}

/** Every response otherwise waits on main, so drop the handler once nothing needs it. */
export function removeBrowserSessionHeadersReceived(session: Electron.Session): void {
  const release = releaseHeadersReceived.get(session)
  if (release) {
    releaseHeadersReceived.delete(session)
    release()
  }
}
