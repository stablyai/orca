import { isAgentBrowserStaleRefError } from '../protocol/agent-browser-batch-command'
import { ORCA_TAB_SESSION_PREFIX } from '../session-lifecycle/agent-browser-session-name'

// Stale refs need a distinct code so agents can retry with a fresh snapshot.
export function classifyErrorCode(message: string): string {
  if (isAgentBrowserStaleRefError(message)) {
    return 'browser_stale_ref'
  }
  return 'browser_error'
}

export function isTabClosedTransportError(message: string): boolean {
  return /session destroyed while command|session destroyed while commands|connection refused|cdp discovery methods failed|websocket connect failed/i.test(
    message
  )
}

/** agent-browser's handshake error when Orca's CDP proxy refuses its endpoint (wrong or missing token). */
export function isCdpProxyRejectedError(message: string): boolean {
  return /websocket connect failed\b.*\b40[34]\b/i.test(message)
}

export function pageUnavailableMessageForSession(sessionName: string): string {
  const prefix = ORCA_TAB_SESSION_PREFIX
  const browserPageId = sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : null
  return browserPageId
    ? `Browser page ${browserPageId} is no longer available`
    : 'Browser tab is no longer available'
}
