import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { committingSpawn } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
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

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'ask-tab'
const WORKTREE_ID = 'wt-1'
const PTY_ID = 'pty-ask'

export async function createRuntimeWithHookRows(
  rows: AgentStatusIpcPayload[],
  statusWiring?: ReturnType<typeof makeAgentStatusStoreWiring>
): Promise<OrcaRuntimeService> {
  const readRows = statusWiring
    ? (): AgentStatusIpcPayload[] => [...rows, ...statusWiring.deps.getAgentStatusSnapshot()]
    : (): AgentStatusIpcPayload[] => rows
  // Main-owned layout requires a store to resolve PTY pane bindings.
  const store = ORCA_LAYOUT_OWNER_IS_MAIN
    ? partialRuntimeStore({
        getRepos: () => [],
        getRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getProjects: () => [],
        getSettings: () => ({})
      })
    : null
  const runtime = new OrcaRuntimeService(store, undefined, {
    ...(statusWiring
      ? {
          captureChatStopInput: statusWiring.deps.captureChatStopInput,
          clearChatStopInput: statusWiring.deps.clearChatStopInput,
          onTerminalAgentStatus: statusWiring.deps.onTerminalAgentStatus,
          reconcileAgentStatusForEndedProcess:
            statusWiring.deps.reconcileAgentStatusForEndedProcess,
          getAgentProviderSessionSnapshot: statusWiring.deps.getAgentProviderSessionSnapshot,
          getAgentProviderSessionRowsForPane: statusWiring.deps.getAgentProviderSessionRowsForPane
        }
      : {}),
    getAgentStatusSnapshot: readRows,
    ...(statusWiring ? {} : { getAgentProviderSessionRowsForPane: readRows })
  })
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn(committingSpawn(runtime, async () => ({ id: PTY_ID }))),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    title: 'Terminal'
  })
  return runtime
}
