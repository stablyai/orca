import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { DispatchContextRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import {
  DISPATCH_CONTEXT_COLUMN_LIST,
  DISPATCH_CONTEXT_COLUMNS,
  selectColumns
} from '../row-column-lists'
import { dispatchCompletionEpoch } from './dispatch-completion-epoch'
import { withPresentationCompletionSource } from './presentation-completion-source'
import { completionTable } from './presentation-completion-schema'
function presentationAddressKey(column: string, address: string | null): string {
  return `${column}:${address}`
}

/** Preserve the terminal projection's exact ISO/SQLite recency contract, including future dates. */
export function isRecentPresentationDispatch(dispatch: DispatchContextRow, now: number): boolean {
  if (!dispatch.completed_at || dispatch.status === 'pending' || dispatch.status === 'dispatched') {
    return false
  }
  const completedAt = dispatchCompletionEpoch(dispatch.completed_at)
  return completedAt !== null && now - completedAt <= AGENT_STATUS_STALE_AFTER_MS
}

export type PresentationDispatchCandidate = DispatchContextRow & { presentation_order: number }

/** Active/recent source facts shared by the keyed index and session presentation. */
export function readPresentationDispatchCandidates(
  db: OrchestrationDb,
  now: number
): PresentationDispatchCandidate[] {
  return withPresentationCompletionSource(db.db, now, () => {
    const rows = db.db
      .prepare(`SELECT rowid AS presentation_order, ${DISPATCH_CONTEXT_COLUMN_LIST}
    FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')
    UNION ALL SELECT d.rowid AS presentation_order, ${selectColumns(DISPATCH_CONTEXT_COLUMNS, 'd')}
    FROM temp.${completionTable} c INDEXED BY orchestration_presentation_completion_epoch
    CROSS JOIN dispatch_contexts d ON d.id = c.id WHERE c.epoch >= ?`)
      .all(now - AGENT_STATUS_STALE_AFTER_MS)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: complete schema-owned dispatch projection plus SQLite rowid.
    return (rows as PresentationDispatchCandidate[]).sort(
      (a, b) => a.presentation_order - b.presentation_order
    )
  })
}

/** Active first, otherwise latest per address; an older eligible completion never resurfaces. */
export function listSessionDispatchesForPresentation(
  this: OrchestrationDb,
  now: number,
  sessions?: readonly string[]
): { dispatch: DispatchContextRow; order: number }[] {
  const candidates = readPresentationDispatchCandidates(this, now).filter(
    (row) =>
      row.assignee_orca_session_id && (!sessions || sessions.includes(row.assignee_orca_session_id))
  )
  const newestActiveOrderBySession = new Map<string, number>()
  const selected = new Map<string, (typeof candidates)[number]>()
  for (const candidate of candidates) {
    // Include handled rows even when a newer non-public row later suppresses their address.
    if (candidate.status === 'pending' || candidate.status === 'dispatched') {
      const session = candidate.assignee_orca_session_id
      if (session) {
        newestActiveOrderBySession.set(
          session,
          Math.max(newestActiveOrderBySession.get(session) ?? 0, candidate.presentation_order)
        )
      }
    }
    const address = presentationAddressKey(
      candidate.assignee_handle ? 'assignee_handle' : 'assignee_orca_session_id',
      candidate.assignee_handle || candidate.assignee_orca_session_id
    )
    const previous = selected.get(address)
    const active = candidate.status === 'pending' || candidate.status === 'dispatched'
    const previousActive = previous?.status === 'pending' || previous?.status === 'dispatched'
    if (
      !previous ||
      (active && !previousActive) ||
      (active === previousActive && candidate.presentation_order > previous.presentation_order)
    ) {
      selected.set(address, candidate)
    }
  }
  const eligible = [...selected].filter(
    ([, candidate]) =>
      candidate.status === 'pending' ||
      candidate.status === 'dispatched' ||
      isRecentPresentationDispatch(candidate, now)
  )
  const latestOrderByAddress = new Map<string, number>()
  for (const [column, active] of [
    ['assignee_handle', true],
    ['assignee_handle', false],
    ['assignee_orca_session_id', false]
  ] as const) {
    const addresses = eligible
      .filter(
        ([, candidate]) =>
          Boolean(candidate.assignee_handle) === (column === 'assignee_handle') &&
          (candidate.status === 'pending' || candidate.status === 'dispatched') === active
      )
      .map(([, candidate]) => candidate[column])
    if (addresses.length === 0) {
      continue
    }
    // Batch native calls, retaining one equality-index seek per selected address.
    const latest = this.db
      .prepare(`SELECT requested.value AS address, (SELECT rowid AS n FROM dispatch_contexts
        WHERE ${column} = requested.value
        ${active ? "AND status IN ('pending', 'dispatched')" : ''}
        ORDER BY rowid DESC LIMIT 1) AS n FROM json_each(?) requested`)
      .all(JSON.stringify(addresses))
    for (const row of latest) {
      if (typeof row.address === 'string' && typeof row.n === 'number') {
        latestOrderByAddress.set(presentationAddressKey(column, row.address), row.n)
      }
    }
  }
  const result: { dispatch: DispatchContextRow; order: number }[] = []
  for (const [address, candidate] of eligible) {
    const { presentation_order, ...dispatch } = candidate
    const active = dispatch.status === 'pending' || dispatch.status === 'dispatched'
    const latest =
      active && !candidate.assignee_handle
        ? newestActiveOrderBySession.get(candidate.assignee_orca_session_id ?? '')
        : latestOrderByAddress.get(address)
    if (latest !== presentation_order) {
      continue
    }
    result.push({ dispatch, order: presentation_order })
  }
  return result
}
