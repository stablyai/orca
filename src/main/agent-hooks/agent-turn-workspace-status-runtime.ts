import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getWorkspaceStatus } from '../../shared/workspace-statuses'
import type { WorkspaceStatus } from '../../shared/worktree/types'
import type { AgentStatusState } from '../../shared/agent-status-types'
import { agentHookServer } from './server'
import type { AgentTurnWorkspaceStatusDeps } from './agent-turn-workspace-status-sync'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const RUNTIME_WORKTREE_ID_SELECTOR_PREFIX = 'id:'

// Why: the row's combined `state` folds live child work in; the turn boundary is the lead's own
// transition, so the main agent's record is read first and `state` only covers hosts that publish none.
function leadStateOf(row: {
  state: AgentStatusState
  mainAgent?: { state: AgentStatusState }
}): AgentStatusState {
  return row.mainAgent?.state ?? row.state
}

/**
 * Host-side bindings for the turn-boundary board move. Runs on the execution host that received the
 * hook, so both reads and writes address that host's own store.
 */
export function agentTurnWorkspaceStatusDeps(
  store: Store,
  runtime: Pick<OrcaRuntimeService, 'updateManagedWorktreeMeta' | 'notifyFolderWorkspaceChanged'>
): AgentTurnWorkspaceStatusDeps {
  return {
    isEnabled: () => store.getUI().syncWorkspaceStatusFromAgentTurns === true,
    getWorkspaceStatuses: () => store.getUI().workspaceStatuses ?? [],
    resolveWorktreeIdForTab: (tabId) => store.getWorktreeIdForTab(tabId),
    getWorkspaceStatus: (worktreeId) => {
      const scope = parseWorkspaceKey(worktreeId)
      const current =
        scope?.type === 'folder'
          ? store.getFolderWorkspace(scope.folderWorkspaceId)?.workspaceStatus
          : store.getWorktreeMeta(worktreeId)?.workspaceStatus
      return getWorkspaceStatus({ workspaceStatus: current }, store.getUI().workspaceStatuses ?? [])
    },
    // Why `providerSessionOnly` rows are dropped: they carry resume identity, not turn state.
    getLivePanes: () =>
      agentHookServer
        .getStatusSnapshot()
        .filter((row) => row.providerSessionOnly !== true)
        .map((row) => ({
          paneKey: row.paneKey,
          worktreeId: row.worktreeId,
          state: leadStateOf(row)
        })),
    setWorkspaceStatus: async (worktreeId, workspaceStatus: WorkspaceStatus) => {
      const scope = parseWorkspaceKey(worktreeId)
      if (scope?.type === 'folder') {
        store.updateFolderWorkspace(scope.folderWorkspaceId, { workspaceStatus })
        runtime.notifyFolderWorkspaceChanged()
        return
      }
      await runtime.updateManagedWorktreeMeta(
        `${RUNTIME_WORKTREE_ID_SELECTOR_PREFIX}${worktreeId}`,
        {
          workspaceStatus
        }
      )
    }
  }
}
