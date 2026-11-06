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

/** Match production status wiring; without republish, the runtime observes rows but publishes none. */
export function makeAgentStatusStoreWiring(): {
  statusStore: AgentHookServer
  deps: ReturnType<typeof agentHookRuntimeDeps>
  attach: (runtime: WiredRuntime) => () => void
} {
  const statusStore = new AgentHookServer()
  return {
    statusStore,
    // OSC-driven specs must not inject hook endpoints.
    deps: agentHookRuntimeDeps(statusStore, new AgentStatusObservedPaneIdentities(), () => ({
      agentStatusHooksEnabled: false
    })),
    attach: (runtime) => installHookStatusSessionTabsRepublish(statusStore, () => runtime)
  }
}
