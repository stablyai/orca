import type { Session } from 'electron'

import type { BrowserSessionUserAgentMode } from '../../shared/browser-workspace-types'

const userAgentModeBySession = new WeakMap<Session, BrowserSessionUserAgentMode>()

export function setBrowserSessionUserAgentMode(
  session: Session,
  mode: BrowserSessionUserAgentMode
): void {
  userAgentModeBySession.set(session, mode)
}

export function getBrowserSessionUserAgentMode(
  session: Session
): BrowserSessionUserAgentMode | undefined {
  return userAgentModeBySession.get(session)
}

export function clearBrowserSessionUserAgentMode(session: Session): void {
  userAgentModeBySession.delete(session)
}
