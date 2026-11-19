import type { Cookie, Session } from 'electron'
import type { CdpCookie } from '../browser-cdp-cookie'
import type { ScopeChange } from './browser-session-cookie-scopes'

export type SessionCookieTracker = {
  target: Session
  filePath: string
  /** What the file holds now, by scope. */
  saved: Map<string, CdpCookie[]>
  /** The file may hold cookies `saved` lacks (it could not be read), so the next save must rewrite it. */
  savedStale: boolean
  /** Set until the file has been read: a save before then would compare against nothing. */
  reading: boolean
  /** Scopes whose cookies changed since `saved` was read. */
  changedScopes: Map<string, ScopeChange>
  /** Set while a save reads: scopes that changed meanwhile, which the read may have missed. */
  changedDuringSave: Map<string, ScopeChange> | null
  timer: ReturnType<typeof setTimeout> | null
  onChanged: (event: Electron.Event, cookie: Cookie, cause: string, removed: boolean) => void
}

export function cancelPendingSave(tracker: SessionCookieTracker): void {
  if (tracker.timer) {
    clearTimeout(tracker.timer)
    tracker.timer = null
  }
}
