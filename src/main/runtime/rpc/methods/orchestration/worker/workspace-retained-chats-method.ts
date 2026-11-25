import {
  ORCHESTRATION_SESSION_WORKERS_LIMIT,
  ORCHESTRATION_WORKSPACE_RETAINED_CHATS_METHOD,
  sessionWorkerIsRunning,
  type OrchestrationSessionWorker,
  type OrchestrationSessionWorkersResult
} from '../../../../../../shared/orchestration-session-workers'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../../../../../shared/orchestration/workers/structured-worker-handle'
import { WorkspaceRetainedChatsParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-worker-release-schemas-params'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { readDispatchWorkers, type SessionWorkersRuntime } from './session-workers-method'

export const ORCHESTRATION_WORKSPACE_RETAINED_CHATS_METHODS = [
  defineOrchestrationMethod({
    name: ORCHESTRATION_WORKSPACE_RETAINED_CHATS_METHOD,
    access: { kind: 'localOnly', targets: {} },
    permission: 'workspace',
    params: WorkspaceRetainedChatsParams,
    handler: async (params, { runtime }): Promise<OrchestrationSessionWorkersResult> => ({
      workers: await readWorkspaceRetainedChats(runtime, params.worktreeId)
    })
  })
]

/** Finished chat workers of this workspace whose chat Orca's release closed and whose conversation
 *  this host still keeps, newest first, once per chat. A follow-up reopening one opens its tab, which drops it. */
export async function readWorkspaceRetainedChats(
  runtime: SessionWorkersRuntime,
  worktreeId: string
): Promise<OrchestrationSessionWorker[]> {
  const rows = runtime
    .getOrchestrationDb()
    .db.prepare(
      `SELECT owner_dispatch_id FROM worker_terminal_resources
        WHERE worktree_id = ? AND release_state = 'released' AND terminal_handle LIKE ?
        ORDER BY updated_at DESC LIMIT ?`
    )
    .all(worktreeId, `${STRUCTURED_WORKER_HANDLE_PREFIX}%`, ORCHESTRATION_SESSION_WORKERS_LIMIT)
  const dispatchIds = rows.flatMap((row) =>
    typeof row === 'object' && row !== null && 'owner_dispatch_id' in row
      ? [String(row.owner_dispatch_id)]
      : []
  )
  const workers = await readDispatchWorkers(runtime, dispatchIds)
  const host = getStructuredAgentSessionHost()
  const seen = new Set<string>()
  return workers.filter((worker) => {
    const sessionId = worker.chatSessionId
    if (
      !host ||
      !sessionId ||
      seen.has(sessionId) ||
      worker.worktreeId !== worktreeId ||
      sessionWorkerIsRunning(worker) ||
      host.isSessionTabVisible(sessionId) ||
      !host.deps.store.getConversation(sessionId)
    ) {
      return false
    }
    seen.add(sessionId)
    return true
  })
}
