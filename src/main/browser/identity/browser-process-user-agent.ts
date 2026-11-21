import { app } from 'electron'
import type { BrowserUserAgentMode } from '../../../shared/browser/identity/browser-user-agent-mode'

export type BrowserProcessUserAgentIdentity = Readonly<{
  mode: BrowserUserAgentMode
  userAgent: string
  /** Electron's UA without the app token; Google sign-in rejects any identity claiming another browser. */
  electronUserAgent: string
}>

let identity: BrowserProcessUserAgentIdentity | null = null

const CHROMIUM_ENGINE_COMMENT = '(KHTML, like Gecko)'

export function stripElectronToken(userAgent: string): string {
  return userAgent.replace(/\s+Electron\/\S+/, '')
}

// Require the engine comment so app-token stripping cannot consume OS/engine tokens.
// App names may contain spaces; keep stripping within the gap before Chrome/.
function stripAppToken(userAgent: string): string {
  if (!userAgent.includes(CHROMIUM_ENGINE_COMMENT)) {
    return userAgent
  }
  return userAgent.replace(/(\)\s+)(?:[^)\s]+\s+)*?(Chrome\/)/, '$1$2')
}

export function cleanElectronUserAgent(userAgent: string): string {
  if (!userAgent.includes(CHROMIUM_ENGINE_COMMENT)) {
    return userAgent
  }
  return stripElectronToken(stripAppToken(userAgent))
}

// Set the shared default before sessions and workers inherit it.
export function initializeBrowserProcessUserAgent(
  mode: BrowserUserAgentMode
): BrowserProcessUserAgentIdentity {
  if (identity) {
    throw new Error('Browser process user agent was already initialized')
  }
  if (app.isReady()) {
    throw new Error('Browser process user agent must be initialized before Electron readiness')
  }
  // WhatsApp Web's server rejects any UA carrying the `Orca/x` token; Cloudflare only needs Electron's.
  const electronUserAgent = stripAppToken(app.userAgentFallback)
  app.userAgentFallback =
    mode === 'clean' ? cleanElectronUserAgent(electronUserAgent) : electronUserAgent
  identity = Object.freeze({ mode, userAgent: app.userAgentFallback, electronUserAgent })
  return identity
}

export function getBrowserProcessUserAgentIdentity(): BrowserProcessUserAgentIdentity {
  if (!identity) {
    throw new Error('Browser process user agent is not initialized')
  }
  return identity
}
