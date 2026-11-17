/** Custody uses worker-terminal state rather than process liveness: mail can start an agent at rest.
 * Only released ends addressability; pending/unknown releases still route. Reclaimable workers owe no work and may rest. */

import type { AgentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../../shared/orchestration/orchestration-task-display'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { canonicalOrcaSessionId } from '../../addressing/session-lineage/canonical-orca-session-id'
import type { RunningStructuredSession } from '../../addressing/session-lineage/structured-session-lineage'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { WorkerDispatchState } from '../../db/orchestration-records'
import {
  deriveWorkerTerminalListState,
  type WorkerTerminalResourceRow
} from '../release/worker-terminal-ownership'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  structuredWorkerHostScope,
  structuredWorkerProcessIncarnation,
  structuredWorkerRecordIsCurrent
} from './structured-worker-identity'

type SessionTabReader = Pick<
  NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  'getPersistedVisibleSessionTabIndex'
>

type CustodySource =
  | ReturnType<typeof captureStructuredWorkerTabVisibility>
  | SessionTabReader
  | null

/** Judge ownership on the resolved successor session; absent host returns null because reading storage would install it. */
export function structuredWorkerOwned(
  running: RunningStructuredSession,
  source?: CustodySource
): boolean | null {
  if (source && 'installed' in source) {
    return source.installed
      ? structuredWorkerRecordIsCurrent(
          running.record,
          running.record.ownerObservation.claimStatus === 'released' &&
            source.isListed(running.sessionId)
        )
      : null
  }
  const host = source === undefined ? getStructuredAgentSessionHost() : source
  if (!host) {
    return null
  }
  return structuredWorkerRecordIsCurrent(
    running.record,
    running.record.ownerObservation.claimStatus === 'released' &&
      structuredSessionTabListed(host, running.sessionId)
  )
}

/** Whether the persisted tab index authoritatively omits the session; an unreadable index does not. */
export function structuredSessionTabRetired(
  host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  sessionId: string
): boolean {
  try {
    if (typeof host.deps?.store?.isSessionTabRetired === 'function') {
      return host.deps.store.isSessionTabRetired(sessionId)
    }
    const index = host.getPersistedVisibleSessionTabIndex?.()
    return index?.present === true && !index.sessionIds.includes(sessionId)
  } catch {
    return false
  }
}

/** Retirement is the tab index: every path that ends a chat for good hides its tab. */
function structuredSessionTabListed(host: SessionTabReader, sessionId: string): boolean {
  try {
    return host.getPersistedVisibleSessionTabIndex?.().sessionIds.includes(sessionId) ?? false
  } catch {
    return false
  }
}

type CustodyRow = Pick<
  WorkerTerminalResourceRow,
  'owner_dispatch_id' | 'terminal_handle' | 'ownership_state' | 'release_state'
>

function ownerState(
  db: OrchestrationDb | null | undefined,
  row: CustodyRow
): WorkerDispatchState | undefined {
  return (
    db?.getWorkerDispatch?.(row.owner_dispatch_id)?.state ??
    db?.getRemoteDispatchAttachment?.(row.owner_dispatch_id)?.state
  )
}

/** Route while the user owns the chat and orchestration has not released it; unreadable ownership returns null. Release never closes the user's chat. */
export function structuredWorkerAddressable(
  db: OrchestrationDb | null | undefined,
  running: RunningStructuredSession,
  row: CustodyRow | undefined,
  source?: CustodySource
): boolean | null {
  const owned = structuredWorkerOwned(running, source)
  if (owned === null) {
    return null
  }
  // Release is read off the row alone, so an owner whose state is unreadable still answers.
  const custody = row
    ? deriveWorkerTerminalListState({
        workerState: ownerState(db, row) ?? 'unsupervised',
        agentTerminalHandle: row.terminal_handle,
        resource: row
      })
    : null
  return owned && custody !== 'released'
}

/** Any pending/dispatched task on this worker incarnation keeps it working, including supervised stops in doubt and later tasks. Clear successors inherit root obligations; reclaimable workers may rest. */
export function structuredWorkerOwesWork(
  db: OrchestrationDb | null,
  record: Pick<AgentSessionConversationView, 'sessionId' | 'location'>
): boolean {
  return structuredWorkersOwingWork(db, [record]).has(record.sessionId)
}

/** The workers among `records` that owe work, read in one statement however many there are. */
export function structuredWorkersOwingWork(
  db: OrchestrationDb | null,
  records: readonly Pick<AgentSessionConversationView, 'sessionId' | 'location'>[]
): ReadonlySet<string> {
  const workers = records.flatMap((record) => {
    const hostScope = structuredWorkerHostScope(record.location)
    return hostScope
      ? [[workerIncarnation(record.sessionId), JSON.stringify(hostScope), record.sessionId]]
      : []
  })
  if (!db || workers.length === 0) {
    return new Set()
  }
  const rows: unknown[] = db.db
    .prepare(
      `SELECT DISTINCT json_extract(worker.value, '$[2]') AS session_id FROM json_each(?) AS worker
        WHERE EXISTS (SELECT 1 FROM worker_terminal_resources
            WHERE process_incarnation = json_extract(worker.value, '$[0]')
              AND host_scope IS json_extract(worker.value, '$[1]') AND ownership_state = 'owned')
          AND EXISTS (SELECT 1 FROM dispatch_contexts
            WHERE process_incarnation = json_extract(worker.value, '$[0]')
              AND status IN ('pending', 'dispatched'))`
    )
    .all(JSON.stringify(workers))
  return new Set(
    rows.flatMap((row) =>
      typeof row === 'object' &&
      row !== null &&
      'session_id' in row &&
      typeof row.session_id === 'string'
        ? [row.session_id]
        : []
    )
  )
}

/** The first task this worker still owes, which names its chat. */
export function structuredWorkerOpenTaskTitle(
  db: OrchestrationDb | null,
  record: Pick<AgentSessionConversationView, 'sessionId' | 'location'>
): { title: string } | null {
  const incarnation = db && ownedWorkerIncarnation(db, record)
  if (!db || !incarnation) {
    return null
  }
  const row: unknown = db.db
    .prepare(
      `SELECT task.task_title, task.spec FROM dispatch_contexts dispatch
        JOIN tasks task ON task.id = dispatch.task_id
        WHERE dispatch.process_incarnation = ? AND dispatch.status IN ('pending', 'dispatched')
        ORDER BY dispatch.rowid LIMIT 1`
    )
    .get(incarnation)
  return typeof row === 'object' &&
    row !== null &&
    'task_title' in row &&
    (typeof row.task_title === 'string' || row.task_title === null) &&
    'spec' in row &&
    typeof row.spec === 'string'
    ? {
        title: buildOrchestrationTaskDisplayMetadata({
          taskTitle: row.task_title,
          spec: row.spec
        }).taskTitle
      }
    : null
}

function workerIncarnation(sessionId: string): string {
  return structuredWorkerProcessIncarnation(
    isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
  )
}

function ownedWorkerIncarnation(
  db: OrchestrationDb,
  record: Pick<AgentSessionConversationView, 'sessionId' | 'location'>
): string | null {
  const hostScope = structuredWorkerHostScope(record.location)
  if (!hostScope) {
    return null
  }
  const incarnation = workerIncarnation(record.sessionId)
  const owned = db.db
    .prepare(
      `SELECT 1 FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ? AND ownership_state = 'owned' LIMIT 1`
    )
    .get(incarnation, JSON.stringify(hostScope))
  return owned === undefined ? null : incarnation
}

/** Finite captured membership; unreadable visibility never proves an open released session. */
export function captureStructuredWorkerTabVisibility() {
  const host = getStructuredAgentSessionHost()
  let listed: ReadonlySet<string> | undefined
  return {
    installed: Boolean(host),
    isListed: (sessionId: string): boolean => {
      if (!listed) {
        try {
          listed = new Set(host?.getPersistedVisibleSessionTabIndex?.().sessionIds ?? [])
        } catch {
          listed = new Set()
        }
      }
      return listed.has(sessionId)
    }
  }
}
