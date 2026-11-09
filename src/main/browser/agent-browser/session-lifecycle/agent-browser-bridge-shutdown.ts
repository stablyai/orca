import { mapSettledWithConcurrency } from '../../../../shared/map-with-concurrency'
import { sweepOrphanedAgentBrowserSessions } from './agent-browser-orphan-sweep'
import { AgentBrowserBridgeLifecycle } from './agent-browser-bridge-lifecycle'
import type { AgentBrowserCleanupOptions } from './agent-browser-cleanup-options'

export abstract class AgentBrowserBridgeShutdown extends AgentBrowserBridgeLifecycle {
  async sweepOrphanedSessions(): Promise<string[]> {
    return sweepOrphanedAgentBrowserSessions({
      binaryPath: this.agentBrowserBin,
      env: this.agentBrowserEnv,
      ownsSocketDirectory: this.ownsAgentBrowserSocketDirectory,
      isSessionLive: (sessionName) =>
        this.sessions.has(sessionName) || this.pendingSessionCreation.has(sessionName)
    })
  }

  async destroyAllSessions(options?: AgentBrowserCleanupOptions): Promise<void> {
    this.shutdownStarted = true
    // Pending creation and destruction can own daemons absent from the session map.
    const sessionNames = new Set([
      ...this.sessions.keys(),
      ...this.pendingSessionCreation.keys(),
      ...this.pendingSessionDestruction.keys()
    ])
    await mapSettledWithConcurrency(
      [...sessionNames],
      AGENT_BROWSER_CLEANUP_CONCURRENCY,
      (sessionName) => this.destroySession(sessionName, options)
    )
    this.pendingInterceptRestore.clear()
  }
}

export const AGENT_BROWSER_CLEANUP_CONCURRENCY = 4
