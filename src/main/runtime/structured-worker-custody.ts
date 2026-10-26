/** Custody uses worker-terminal state rather than process liveness: mail can start an agent at rest.
 * Only released ends addressability; pending/unknown releases still route. Reclaimable workers owe no work and may rest. */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import { isOrcaSessionId } from '../../shared/orca-session-address'
import { canonicalOrcaSessionId } from './orchestration/canonical-orca-session-id'
import type { RunningStructuredSession } from './orchestration/structured-session-lineage'
import type { OrchestrationDb } from './orchestration/db'
import type { WorkerDispatchState } from './orchestration/types'
import {
  deriveWorkerTerminalListState,
  type WorkerTerminalResourceRow
} from './orchestration/worker-terminal-ownership'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredWorkerHostScope,
  structuredWorkerProcessIncarnation,
  structuredWorkerRecordIsCurrent
} from './structured-worker-identity'

/** Judge ownership on the resolved successor session; absent host returns null because reading storage would install it. */
export function structuredWorkerOwned(running: RunningStructuredSession): boolean | null {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  return structuredWorkerRecordIsCurrent(
    running.record,
    running.record.lease.claimStatus === 'released' &&
      structuredSessionTabListed(host, running.sessionId)
  )
}

/** Whether the persisted tab index authoritatively omits the session; an unreadable index does not. */
export function structuredSessionTabRetired(
  host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  sessionId: string
): boolean {
  try {
    const index = host.getPersistedVisibleSessionTabIndex?.()
    return index?.present === true && !index.sessionIds.includes(sessionId)
  } catch {
    return false
  }
}

/** Retirement is the tab index: every path that ends a chat for good hides its tab. */
function structuredSessionTabListed(
  host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  sessionId: string
): boolean {
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
  row: CustodyRow | undefined
): boolean | null {
  const owned = structuredWorkerOwned(running)
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
  record: AgentSessionRecord
): boolean {
  const incarnation = db && ownedWorkerIncarnation(db, record)
  return (
    !!db &&
    !!incarnation &&
    db.db
      .prepare(
        `SELECT 1 FROM dispatch_contexts
          WHERE process_incarnation = ? AND status IN ('pending', 'dispatched') LIMIT 1`
      )
      .get(incarnation) !== undefined
  )
}

/** The first task this worker still owes, which names its chat. */
export function structuredWorkerOpenTaskTitle(
  db: OrchestrationDb | null,
  record: AgentSessionRecord
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

function ownedWorkerIncarnation(db: OrchestrationDb, record: AgentSessionRecord): string | null {
  const hostScope = structuredWorkerHostScope(record.location)
  if (!hostScope) {
    return null
  }
  const incarnation = structuredWorkerProcessIncarnation(
    isOrcaSessionId(record.sessionId) ? canonicalOrcaSessionId(record.sessionId) : record.sessionId
  )
  const owned = db.db
    .prepare(
      `SELECT 1 FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ? AND ownership_state = 'owned' LIMIT 1`
    )
    .get(incarnation, JSON.stringify(hostScope))
  return owned === undefined ? null : incarnation
}
