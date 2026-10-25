import { AgentHookServer } from '../agent-hooks/server'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import { AgentStatusObservedPaneIdentities } from './agent-status-observed-pane-identity'

type WiredRuntime = {
  getTerminalWorktreeIdForHandle(handle: string): string | null
  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null
  scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(worktreeId: string): void
  touchMobileSessionTabsForWorktree(worktreeId: string): void
}

/**
 * The agent-status wiring every real host performs, for the runtime specs: the same
 * `agentHookRuntimeDeps` bindings plus the republish signal. A runtime constructed without these
 * observes agent status and publishes it nowhere.
 */
export function makeAgentStatusStoreWiring(): {
  statusStore: AgentHookServer
  deps: ReturnType<typeof agentHookRuntimeDeps>
  /** Call once the runtime exists; returns the republish teardown. */
  attach: (runtime: WiredRuntime) => () => void
} {
  const statusStore = new AgentHookServer()
  return {
    statusStore,
    // Hooks off: these specs drive status through OSC, and must not inject hook endpoint env.
    deps: agentHookRuntimeDeps(statusStore, new AgentStatusObservedPaneIdentities(), () => ({
      agentStatusHooksEnabled: false
    })),
    attach: (runtime) => installHookStatusSessionTabsRepublish(statusStore, () => runtime)
  }
}
