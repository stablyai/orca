import {
  ORCHESTRATION_SESSION_WORKERS_LIMIT,
  ORCHESTRATION_WORKSPACE_RETAINED_CHATS_METHOD,
  type OrchestrationSessionWorker,
  type OrchestrationSessionWorkersResult
} from '../../../../../../shared/orchestration-session-workers'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../../../../../shared/orchestration/workers/structured-worker-handle'
import { WorkspaceRetainedChatsParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-worker-release-schemas-params'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import {
  resolveStructuredWorkerIdentity,
  structuredWorkerSession
} from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
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
 *  this host still keeps, newest first, once per chat. Eligibility is judged before the limit, so
 *  open or deleted chats never crowd out older kept ones; a reopened chat's open tab drops it. */
export async function readWorkspaceRetainedChats(
  runtime: SessionWorkersRuntime,
  worktreeId: string
): Promise<OrchestrationSessionWorker[]> {
  const db = runtime.getOrchestrationDb()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return []
  }
  const rows = db.db
    .prepare(
      `SELECT owner_dispatch_id, terminal_handle FROM worker_terminal_resources
        WHERE worktree_id = ? AND release_state = 'released' AND terminal_handle LIKE ?
        ORDER BY updated_at DESC`
    )
    .all(worktreeId, `${STRUCTURED_WORKER_HANDLE_PREFIX}%`)
  const seen = new Set<string>()
  const dispatchIds: string[] = []
  for (const row of rows) {
    if (dispatchIds.length >= ORCHESTRATION_SESSION_WORKERS_LIMIT) {
      break
    }
    if (
      typeof row !== 'object' ||
      row === null ||
      !('terminal_handle' in row) ||
      !('owner_dispatch_id' in row)
    ) {
      continue
    }
    const identity = resolveStructuredWorkerIdentity(String(row.terminal_handle), db)
    if (!identity) {
      continue
    }
    // The session that holds the conversation now, as a reopen would pick it after a `/clear`.
    const running = structuredWorkerSession(identity)
    const sessionId = running.kind === 'here' ? running.sessionId : identity.sessionId
    if (
      seen.has(sessionId) ||
      host.isSessionTabVisible(sessionId) ||
      !host.deps.store.getConversation(sessionId)
    ) {
      continue
    }
    seen.add(sessionId)
    dispatchIds.push(String(row.owner_dispatch_id))
  }
  return readDispatchWorkers(runtime, dispatchIds)
}
