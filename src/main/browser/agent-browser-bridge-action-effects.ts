import { BrowserError } from './cdp-bridge'
import { AgentBrowserBridgeShutdown } from './agent-browser-bridge-shutdown'
import type { ResolvedBrowserCommandTarget } from './agent-browser-bridge-types'
import { assertRemoteCliPageAccess } from './remote-cli-page-admission'
import type { ActionEffectsHost } from './agent-browser-action-effects'

const EFFECTS_SNAPSHOT_TIMEOUT_MS = 5_000

export abstract class AgentBrowserBridgeActionEffects extends AgentBrowserBridgeShutdown {
  protected actionEffectsHost(
    worktreeId: string | undefined,
    browserPageId: string,
    sessionName: string
  ): ActionEffectsHost {
    const currentTarget = (): ResolvedBrowserCommandTarget =>
      this.resolveCommandTarget(worktreeId, browserPageId)
    const workspaceTabs = (): Map<string, number> =>
      this.getRegisteredTabs(this.browserManager.getWorktreeIdForTab(browserPageId))
    return {
      guest: () => {
        try {
          return this.getWebContents(currentTarget().webContentsId)
        } catch {
          return null
        }
      },
      tabUrls: () =>
        new Map(
          [...workspaceTabs()].map(([tabId, webContentsId]) => {
            const wc = this.getWebContents(webContentsId)
            try {
              assertRemoteCliPageAccess(webContentsId)
            } catch {
              return [tabId, null]
            }
            return [tabId, wc?.getURL() ?? null]
          })
        ),
      loadError: () => {
        const error = this.browserManager.getBrowserPageLoadError(browserPageId)
        return error ? `${error.description} (${error.code})` : null
      },
      hasDeltaBaseline: () => {
        const session = this.sessions.get(sessionName)
        return session?.hasDeltaBaseline === true && !this.isDaemonIdledOut(session)
      },
      forgetDeltaBaseline: () => this.forgetDeltaBaseline(sessionName),
      snapshotDelta: async () => {
        // Helper-free fast paths start the session here; a process swap reattaches it.
        await this.ensureSession(sessionName, browserPageId, currentTarget().webContentsId)
        const reply = await this.execAgentBrowser(sessionName, ['snapshot', '--delta'], {
          // A wedged page must not hold a finished action for agent-browser's 30 s.
          timeoutMs: EFFECTS_SNAPSHOT_TIMEOUT_MS,
          timeoutError: new BrowserError('browser_timeout', 'Timed out reading the page')
        })
        const session = this.sessions.get(sessionName)
        if (session) {
          session.hasDeltaBaseline = true
        }
        return reply
      },
      observePageEvents: (listener) =>
        this.browserManager.observePageEvents(browserPageId, listener),
      admit: (webContentsId) => assertRemoteCliPageAccess(webContentsId)
    }
  }

  /** The daemon's delta baseline is no longer the page the agent last saw. */
  protected forgetDeltaBaseline(sessionName: string): void {
    const session = this.sessions.get(sessionName)
    if (session) {
      session.hasDeltaBaseline = false
    }
  }
}
