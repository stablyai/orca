import { AgentHookServer } from '../agent-hooks/server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'

type WiredRuntime = {
  getTerminalWorktreeIdForHandle(handle: string): string | null
  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null
  scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree(worktreeId: string): void
  touchMobileSessionTabsForWorktree(worktreeId: string): void
  resolveAgentHookTerminalPane(paneKey: string, connectionId?: string | null): string | undefined
}

/**
 * The agent-status wiring every real host performs, in one place for the runtime specs.
 *
 * `main-process-runtime-service.ts` and `orcad-entry.ts` both hand the runtime's OSC parse to
 * the store, read the listing back out of it, install the republish signal, and let the store
 * ask the runtime where a hook's terminal is now. A runtime
 * constructed without these observes agent status and publishes it nowhere, so a spec that
 * exercises OSC 9999 has to compose the same three parts.
 */
export function makeAgentStatusStoreWiring(): {
  statusStore: AgentHookServer
  deps: {
    onTerminalAgentStatus: (event: Parameters<AgentHookServer['ingestTerminalStatus']>[0]) => void
    getAgentStatusSnapshot: () => ReturnType<AgentHookServer['getStatusSnapshot']>
    getAgentProviderSessionSnapshot: () => ReturnType<AgentHookServer['getStatusSnapshot']>
    getAgentProviderSessionRowsForPane: (
      paneKey: string
    ) => ReturnType<AgentHookServer['getStatusSnapshotForPane']>
    reconcileAgentStatusForEndedProcess: (
      paneKeys: Parameters<AgentHookServer['reconcileEndedProcessForPaneKeys']>[0]
    ) => void
    reconcileAgentStatusForMovedTerminals: (
      moves: Parameters<AgentHookServer['reconcileMovedTerminalPaneKeys']>[0]
    ) => void
  }
  /** Call once the runtime exists; returns the republish teardown. */
  attach: (runtime: WiredRuntime) => () => void
} {
  const statusStore = new AgentHookServer()
  return {
    statusStore,
    deps: {
      onTerminalAgentStatus: (event) => statusStore.ingestTerminalStatus(event),
      getAgentStatusSnapshot: () =>
        statusStore.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
      getAgentProviderSessionSnapshot: () => statusStore.getStatusSnapshot(),
      getAgentProviderSessionRowsForPane: (paneKey) =>
        statusStore.getStatusSnapshotForPane(paneKey),
      reconcileAgentStatusForEndedProcess: (paneKeys) => {
        statusStore.reconcileEndedProcessForPaneKeys(paneKeys)
      },
      reconcileAgentStatusForMovedTerminals: (moves) =>
        statusStore.reconcileMovedTerminalPaneKeys(moves)
    },
    attach: (runtime) => {
      statusStore.setTerminalPaneResolver((paneKey, connectionId) =>
        runtime.resolveAgentHookTerminalPane(paneKey, connectionId)
      )
      const uninstall = installHookStatusSessionTabsRepublish(statusStore, () => runtime)
      return () => {
        statusStore.setTerminalPaneResolver(null)
        uninstall()
      }
    }
  }
}
