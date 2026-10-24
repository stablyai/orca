import { agentHookServer } from './server'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import {
  maybeSyncWorkspaceStatusOnAgentTurn,
  type AgentTurnWorkspaceStatusEvent
} from './agent-turn-workspace-status-sync'
import { agentTurnWorkspaceStatusDeps } from './agent-turn-workspace-status-runtime'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

function turnEventOf(enriched: EnrichedAgentHookEventPayload): AgentTurnWorkspaceStatusEvent {
  return {
    paneKey: enriched.paneKey,
    tabId: enriched.tabId,
    worktreeId: enriched.worktreeId,
    leadState: enriched.payload.mainAgent?.state,
    rowState: enriched.payload.state,
    leadOutcome: enriched.payload.mainAgent?.outcome,
    sessionBoundary: enriched.payload.sessionBoundary,
    isReplay: enriched.isReplay,
    restoredUnconfirmed: enriched.restoredUnconfirmed,
    providerSessionOnly: enriched.providerSessionOnly
  }
}

/**
 * Subscribes the opt-in turn-boundary board move to the hook server. Wired where the hook server
 * lives, so the desktop and headless `orca serve` both move cards on the host that owns the agent.
 */
export function subscribeWorkspaceStatusToAgentTurns(
  store: Store,
  runtime: Pick<OrcaRuntimeService, 'updateManagedWorktreeMeta' | 'notifyFolderWorkspaceChanged'>
): void {
  const deps = agentTurnWorkspaceStatusDeps(store, runtime)
  // Why queue by workspace: emitEnrichedStatus calls this synchronously but the move awaits an async
  // write, so back-to-back boundaries for one workspace would read the column before the prior write
  // lands and skip it. Same workspace runs in turn; different workspaces stay parallel.
  const queueByWorktree = new Map<string, Promise<void>>()
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    const event = turnEventOf(enriched)
    const worktreeId =
      (event.tabId ? deps.resolveWorktreeIdForTab(event.tabId) : undefined) ?? event.worktreeId
    if (!worktreeId) {
      void maybeSyncWorkspaceStatusOnAgentTurn(event, deps)
      return
    }
    const previous = queueByWorktree.get(worktreeId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => maybeSyncWorkspaceStatusOnAgentTurn(event, deps))
    queueByWorktree.set(worktreeId, next)
    void next
      .catch(() => undefined)
      .finally(() => {
        if (queueByWorktree.get(worktreeId) === next) {
          queueByWorktree.delete(worktreeId)
        }
      })
  })
}
