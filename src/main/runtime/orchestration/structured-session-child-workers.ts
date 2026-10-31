import { z } from 'zod'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type {
  OrchestrationChildConversation,
  OrchestrationSessionChildren
} from '../../../shared/orchestration-session-children'
import type { NativeChatSubagentState } from '../../../shared/native-chat-types'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow, FederatedDispatchRow } from './types'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { OrchestrationError } from './orchestration-error'
import {
  resolveLineageRunningSession,
  type AgentSessionRecordReader,
  type LineageRunningSession
} from './structured-session-lineage'
import {
  sessionIdFromStructuredWorkerIncarnation,
  structuredWorkerHostScope
} from '../structured-worker-identity'
import { readWorkerTerminalHostScope } from '../../../shared/worker-terminal-host-scope'
import { structuredSessionChildMetadata } from './structured-session-child-metadata'

const dispatchIds = z.array(
  z.object({ id: z.string(), startedAt: z.number(), settledAt: z.number().nullable() })
)
const PAGE_SIZE = 100

export function structuredSessionChildWorkers(args: {
  db: OrchestrationDb
  records: AgentSessionRecordReader
  sessionId: OrcaSessionId
  dispatchId?: string
  cursor?: string
}): OrchestrationSessionChildren {
  const { db, records } = args
  const parent = resolveLineageRunningSession(records, args.sessionId)
  if (parent.kind !== 'here') {
    throw new OrchestrationError(
      'session_history_unavailable',
      'The parent conversation is unavailable on this host.'
    )
  }
  const parentId = canonicalOrcaSessionId(args.sessionId, records)
  if (args.dispatchId) {
    const owner = db.getDispatchContextById(args.dispatchId)
    if (owner?.assignee_orca_session_id !== parentId) {
      throw new OrchestrationError(
        'worker_identity_changed',
        'The Dispatch does not name this conversation.'
      )
    }
  }
  if (args.cursor) {
    const cursor = db.getDispatchContextById(args.cursor)
    if (
      cursor?.creator_orca_session_id !== parentId ||
      (args.dispatchId !== undefined && cursor.creator_dispatch_id !== args.dispatchId)
    ) {
      throw new OrchestrationError(
        'invalid_argument',
        'The child cursor belongs to another conversation.'
      )
    }
  }
  const ids = dispatchIds.parse(
    db.db
      .prepare(`
    SELECT id, unixepoch(COALESCE(dispatched_at, created_at)) * 1000 AS startedAt,
      unixepoch(completed_at) * 1000 AS settledAt FROM dispatch_contexts
    WHERE creator_orca_session_id = ?
      AND (assignee_orca_session_id IS NULL OR assignee_orca_session_id != ?)
      AND (? IS NULL OR creator_dispatch_id = ?)
      AND (? IS NULL OR rowid < (SELECT rowid FROM dispatch_contexts WHERE id = ?))
    ORDER BY rowid DESC LIMIT ?
  `)
      .all(
        parentId,
        parentId,
        args.dispatchId ?? null,
        args.dispatchId ?? null,
        args.cursor ?? null,
        args.cursor ?? null,
        PAGE_SIZE + 1
      )
  )
  const page = ids.slice(0, PAGE_SIZE)
  return {
    children: page.flatMap(({ id, startedAt, settledAt }) => {
      const dispatch = db.getDispatchContextById(id)
      const task = dispatch ? db.getTask(dispatch.task_id) : undefined
      if (!dispatch || !task) {
        return []
      }
      const worker = db.getWorkerDispatch(id)
      const workerState = worker?.state ?? dispatch.status
      const resource = db.getWorkerTerminalResourceByOwner(id)
      const federation = db.getFederatedDispatch(id)
      const resourceMatches =
        (resource?.process_incarnation == null ||
          resource.process_incarnation === dispatch.process_incarnation) &&
        (resource?.pane_key == null || resource.pane_key === dispatch.assignee_pane_key)
      const sessionId = dispatch.assignee_orca_session_id
      const recordedSessionId = sessionIdFromStructuredWorkerIncarnation(
        dispatch.process_incarnation
      )
      const running =
        !federation &&
        resourceMatches &&
        sessionId &&
        (recordedSessionId === null || recordedSessionId === sessionId)
          ? resolveLineageRunningSession(records, sessionId)
          : null
      const session =
        running &&
        running.kind !== 'unverifiable' &&
        (resource?.worktree_id == null ||
          resource.worktree_id === running.record.location.workspaceId)
          ? running.record
          : null
      const metadata = structuredSessionChildMetadata({
        dispatch,
        worker,
        resource,
        federation,
        session
      })
      return [
        {
          dispatchId: id,
          taskId: dispatch.task_id,
          runId: dispatch.run_id,
          label: task.display_name ?? task.task_title ?? task.spec.split('\n')[0] ?? task.id,
          state: childState(workerState),
          workerState,
          startedAt,
          ...(settledAt === null ? {} : { settledAt }),
          // A Task can be retried; its new attempt's result never belongs to an older Dispatch.
          result:
            db.getDispatchContext(dispatch.task_id)?.id === id
              ? task.result
              : dispatch.last_failure,
          conversation: childConversation(dispatch, resource, federation, resourceMatches, running),
          ...(metadata ? { metadata } : {})
        }
      ]
    }),
    nextCursor: ids.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null
  }
}

function childState(state: string): NativeChatSubagentState {
  switch (state) {
    case 'starting':
    case 'ready':
    case 'pending':
    case 'dispatched':
      return 'working'
    case 'completed':
    case 'succeeded':
      return 'completed'
    case 'failed':
    case 'circuit_broken':
      return 'failed'
    case 'stopped':
    case 'abandoned':
      return 'stopped'
    default:
      return 'unverifiable'
  }
}

function childConversation(
  dispatch: DispatchContextRow,
  resource: WorkerTerminalResourceRow | undefined,
  federation: FederatedDispatchRow | undefined,
  resourceMatches: boolean,
  running: LineageRunningSession | null
): OrchestrationChildConversation {
  const scopes = [dispatch.host_scope, resource?.host_scope].map(readWorkerTerminalHostScope)
  if (
    federation ||
    scopes.some(
      (scope) => scope.kind === 'remote' || (scope.kind === 'local' && scope.scope?.kind === 'wsl')
    )
  ) {
    return { kind: 'unavailable', reason: 'remote-worker' }
  }
  if (
    scopes.some(
      (scope) => scope.kind === 'unreadable' || (scope.kind === 'local' && scope.id !== 'local')
    ) ||
    !resourceMatches
  ) {
    return { kind: 'unavailable', reason: 'identity-unverifiable' }
  }
  const sessionId = dispatch.assignee_orca_session_id
  const recordedSessionId = sessionIdFromStructuredWorkerIncarnation(dispatch.process_incarnation)
  if (!sessionId) {
    return {
      kind: 'unavailable',
      reason:
        recordedSessionId || !dispatch.assignee_handle ? 'identity-unverifiable' : 'terminal-worker'
    }
  }
  if (recordedSessionId !== null && recordedSessionId !== sessionId) {
    return { kind: 'unavailable', reason: 'identity-unverifiable' }
  }
  if (
    !running ||
    running.kind !== 'here' ||
    !structuredWorkerHostScope(running.record.location) ||
    (resource?.worktree_id != null && resource.worktree_id !== running.record.location.workspaceId)
  ) {
    return { kind: 'unavailable', reason: 'identity-unverifiable' }
  }
  return {
    kind: 'journal',
    sessionId: running.sessionId,
    agent: running.record.provider,
    workspaceId: running.record.location.workspaceId
  }
}
