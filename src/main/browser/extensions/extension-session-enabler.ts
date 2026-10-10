import type { Session } from 'electron'

let enabler: ((session: Session) => void) | null = null
const enabledSessions = new WeakSet<Session>()

/** Set by extension-sessions when the app loads it; unit tests never do, so they get no setup. */
export function setBrowserExtensionSessionEnabler(next: (session: Session) => void): void {
  enabler = next
}

/** Gives a browser session Chrome extensions, once the app has loaded extension support. */
export function enableBrowserExtensionsForSession(session: Session): void {
  if (enabler) {
    enabledSessions.add(session)
    enabler(session)
  }
}

/** Whether the session runs extensions, so its pages are extension tabs. */
export function hasBrowserExtensions(session: Session): boolean {
  return enabledSessions.has(session)
}
