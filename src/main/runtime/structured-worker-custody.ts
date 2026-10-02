/**
 * Whether orchestration still holds a structured worker, the one answer every reader derives from.
 *
 * Custody is the orchestration's own worker-terminal state, the list state `worker-list` shows
 * coordinators, never whether the worker's process runs: a worker at rest is still held, and mail
 * starts it. Routing, group addressing and `worker-show` ask whether it is addressable; the idle
 * sweep asks whether it still owes work.
 *
 * Two policy decisions live here and nowhere else: only `released` ends addressability (a release
 * pending or in doubt still routes, as for a terminal worker), and a settled worker awaiting its
 * coordinator's decision (`reclaimable`) owes no work, so it may rest.
 */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
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

/**
 * Work orchestration still owes on this worker, read per sweep tick: any unsettled dispatch
 * addressed to its incarnation, on a process this host owns a terminal for. That covers its own
 * worker-start dispatch (whose context stays open while the worker is active, a stop in doubt
 * included, because a supervised worker's context settles only with it) and any task later
 * dispatched to it. A `reclaimable` worker's dispatch has settled, so it owes nothing.
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
  const owned = db.db
    .prepare(
      `SELECT 1 FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ? AND ownership_state = 'owned' LIMIT 1`
    )
    .get(incarnation, JSON.stringify(hostScope))
  return (
    owned !== undefined &&
    db.db
      .prepare(
        `SELECT 1 FROM dispatch_contexts
          WHERE process_incarnation = ? AND status IN ('pending', 'dispatched') LIMIT 1`
      )
      .get(incarnation) !== undefined
  )
}
