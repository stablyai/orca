import { app } from 'electron'
import type { BrowserUserAgentMode } from '../../shared/browser-user-agent-mode'

export type BrowserProcessUserAgentIdentity = Readonly<{
  mode: BrowserUserAgentMode
  /** What every document, frame and worker in this process presents. */
  userAgent: string
}>

let identity: BrowserProcessUserAgentIdentity | null = null

const CHROMIUM_ENGINE_COMMENT = '(KHTML, like Gecko)'

// Why: Electron's default includes its runtime and app tokens, which invalidate Chrome-imported sessions.
// Why gated on the engine comment: the app-token strip anchors on the nearest ")" before Chrome/, so a
// user agent without one would anchor on the OS comment and eat a real engine token. Only
// Chromium-shaped identities are cleaned; anything else is returned byte-identical.
// Why that anchor never crosses another ")": app.setName decides the app token, and dev uses a name
// containing a space ("Orca Dev"), which a single \S+ cannot span — it left the app name on the wire.
// Consuming only non-")" tokens keeps the match inside the gap between the engine comment and Chrome/.
export function cleanElectronUserAgent(userAgent: string): string {
  if (!userAgent.includes(CHROMIUM_ENGINE_COMMENT)) {
    return userAgent
  }
  return userAgent
    .replace(/\s+Electron\/\S+/, '')
    .replace(/(\)\s+)(?:[^)\s]+\s+)*?(Chrome\/)/, '$1$2')
}

/**
 * Fix the whole process's browser identity before anything can read it.
 *
 * `app.userAgentFallback` is the one default every renderer, frame and worker inherits, so this
 * must land before `ready`: a session or WebContents created first keeps the old value, and
 * workers would then disagree with documents. `native` deliberately leaves the fallback alone
 * rather than assigning the raw string back, so the engine keeps its own untouched default.
 */
export function initializeBrowserProcessUserAgent(
  mode: BrowserUserAgentMode
): BrowserProcessUserAgentIdentity {
  if (identity) {
    throw new Error('Browser process user agent was already initialized')
  }
  if (app.isReady()) {
    throw new Error('Browser process user agent must be initialized before Electron readiness')
  }
  if (mode === 'clean') {
    app.userAgentFallback = cleanElectronUserAgent(app.userAgentFallback)
  }
  identity = Object.freeze({ mode, userAgent: app.userAgentFallback })
  return identity
}

export function getBrowserProcessUserAgentIdentity(): BrowserProcessUserAgentIdentity {
  if (!identity) {
    throw new Error('Browser process user agent is not initialized')
  }
  return identity
}

export function resetBrowserProcessUserAgentForTests(): void {
  identity = null
}
