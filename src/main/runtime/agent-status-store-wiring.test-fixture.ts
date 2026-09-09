import { AgentHookServer } from '../agent-hooks/server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'

type WiredRuntime = {
  touchMobileSessionTabsForPane(paneKey: string, worktreeId?: string | null): void
}

/**
 * The agent-status wiring every real host performs, in one place for the runtime specs.
 *
 * `main-process-runtime-service.ts` and `orcad-entry.ts` both hand the runtime's OSC parse to
 * the store, read the listing back out of it, and install the republish signal. A runtime
 * constructed without these observes agent status and publishes it nowhere, so a spec that
 * exercises OSC 9999 has to compose the same three parts.
 */
export function makeAgentStatusStoreWiring(): {
  statusStore: AgentHookServer
  deps: {
    onTerminalAgentStatus: (event: Parameters<AgentHookServer['ingestTerminalStatus']>[0]) => void
    getAgentStatusSnapshot: () => ReturnType<AgentHookServer['getStatusSnapshot']>
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
        statusStore.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true)
    },
    attach: (runtime) => installHookStatusSessionTabsRepublish(statusStore, () => runtime)
  }
}
