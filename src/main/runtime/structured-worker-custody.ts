/**
 * Whether orchestration still holds a structured worker, the one answer every reader derives from.
 *
 * Custody is the orchestration's own worker-terminal state, the list state `worker-list` shows
 * coordinators, never whether the worker's process runs: a worker at rest is still held, and mail
 * starts it. Routing, group addressing and `worker-show` ask whether it is addressable; the idle
 * sweep asks whether it still owes work.
 */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { OrchestrationDb } from './orchestration/db'
import type { WorkerDispatchState } from './orchestration/types'
import {
  deriveWorkerTerminalListState,
  type WorkerDispatchListState,
  type WorkerTerminalListState,
  type WorkerTerminalResourceRow
} from './orchestration/worker-terminal-ownership'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  structuredWorkerHostScope,
  structuredWorkerProcessIncarnation,
  structuredWorkerRecordIsCurrent
} from './structured-worker-identity'

/**
 * Whether this runtime still owns the worker's session: routing, addressing and authority ask
 * this, never whether its process runs. Null when the host is not installed, because reading the
 * record store would install it — not being able to look is not an answer.
 */
export function structuredWorkerOwned(sessionId: string): boolean | null {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  let record: AgentSessionRecord | null
  try {
    record = host.deps.store.getRecord(sessionId)
  } catch {
    record = null
  }
  return structuredWorkerRecordIsCurrent(
    record,
    record?.lease.claimStatus === 'released' && structuredWorkerTabListed(host, sessionId)
  )
}

/** Retirement is the tab index: every path that ends a chat for good hides its tab. */
function structuredWorkerTabListed(
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

function custodyState(
  row: CustodyRow,
  workerState: WorkerDispatchListState
): WorkerTerminalListState | null {
  return deriveWorkerTerminalListState({
    workerState,
    agentTerminalHandle: row.terminal_handle,
    resource: row
  })
}

/**
 * The user still owns the chat and orchestration has not released the worker, as with a terminal
 * worker whose terminal closed. Null when ownership cannot be read. A released worker's chat stays
 * the user's; nothing routes to it.
 */
export function structuredWorkerAddressable(
  db: OrchestrationDb | null | undefined,
  sessionId: string,
  row: CustodyRow | undefined
): boolean | null {
  const owned = structuredWorkerOwned(sessionId)
  // Release is read off the row alone, so an owner whose state is unreadable still answers.
  return owned === null
    ? null
    : owned && (!row || custodyState(row, ownerState(db, row) ?? 'unsupervised') !== 'released')
}

/**
 * Work orchestration still owes on this worker, read per sweep tick: a resource whose custody is
 * `active` (its worker-start dispatch has not settled, a stop in doubt included), or any unsettled
 * task later dispatched to the same incarnation on a process this host owns a terminal for.
 * A settled worker awaiting its coordinator's decision (`reclaimable`) may rest.
 */
export function structuredWorkerOwesWork(
  db: OrchestrationDb | null,
  record: AgentSessionRecord
): boolean {
  const hostScope = structuredWorkerHostScope(record.location)
  if (!db || !hostScope) {
    return false
  }
  const incarnation = structuredWorkerProcessIncarnation(record.sessionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  const owned = db.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ? AND ownership_state = 'owned'`
    )
    .all(incarnation, JSON.stringify(hostScope)) as WorkerTerminalResourceRow[]
  return (
    owned.some((row) => {
      const workerState = ownerState(db, row)
      return workerState !== undefined && custodyState(row, workerState) === 'active'
    }) ||
    (owned.length > 0 &&
      db.db
        .prepare(
          `SELECT 1 FROM dispatch_contexts
            WHERE process_incarnation = ? AND status IN ('pending', 'dispatched') LIMIT 1`
        )
        .get(incarnation) !== undefined)
  )
}
