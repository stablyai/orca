import { app } from 'electron'
import type { BrowserUserAgentMode } from '../../shared/browser-user-agent-mode'

export type BrowserProcessUserAgentIdentity = Readonly<{
  mode: BrowserUserAgentMode
  userAgent: string
}>

let identity: BrowserProcessUserAgentIdentity | null = null

const CHROMIUM_ENGINE_COMMENT = '(KHTML, like Gecko)'

// Require the engine comment so app-token stripping cannot consume OS/engine tokens.
// App names may contain spaces; keep stripping within the gap before Chrome/.
export function cleanElectronUserAgent(userAgent: string): string {
  if (!userAgent.includes(CHROMIUM_ENGINE_COMMENT)) {
    return userAgent
  }
  return userAgent
    .replace(/\s+Electron\/\S+/, '')
    .replace(/(\)\s+)(?:[^)\s]+\s+)*?(Chrome\/)/, '$1$2')
}

// Set the shared default before sessions and workers inherit it; native mode leaves it browser-owned.
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
