import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import { sweepOrphanedAgentBrowserSessions } from './agent-browser-orphan-sweep'
import { AgentBrowserBridgeLifecycle } from './agent-browser-bridge-lifecycle'
import {
  AGENT_BROWSER_CLEANUP_CONCURRENCY,
  type AgentBrowserCleanupOptions
} from './agent-browser-bridge-types'

export abstract class AgentBrowserBridgeShutdown extends AgentBrowserBridgeLifecycle {
  // ── Session lifecycle ──

  // Why: a previous run that crashed or was SIGKILL'd left one daemon per open tab with
  // nobody holding its name — closeStaleAgentBrowserSession only resets a name being reused.
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
    // Why the union: a session still being created has already spawned its daemon but is not in
    // `sessions` yet, so closing only `sessions` lets that daemon outlive the quit (#16367).
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
