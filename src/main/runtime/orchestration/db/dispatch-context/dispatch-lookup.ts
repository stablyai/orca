import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { DispatchContextRow } from '../../types'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  isEquivalentPaneKey,
  paneKeyMatchSuffix
} from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../row-column-lists'

// Hoist explicit projections so graph-publish queries hit the statement cache.
const ACTIVE_DISPATCH_BY_HANDLE_SQL =
  // Newest-first avoids selecting a stale row when one handle has multiple active Dispatches.
  `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE assignee_handle = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC LIMIT 1`
const ACTIVE_DISPATCH_BY_PANE_KEY_SQL = `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE assignee_pane_key = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC LIMIT 1`
const ACTIVE_DISPATCH_BY_PANE_SUFFIX_SQL = `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE assignee_pane_key IS NOT NULL
         AND status IN ('pending', 'dispatched') AND instr(assignee_pane_key, ':') > 1
         AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
       ORDER BY rowid DESC LIMIT 1`
const LATEST_DISPATCH_BY_HANDLE_SQL = `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE assignee_handle = ? ORDER BY rowid DESC LIMIT 1`

function presentationAddressKey(column: string, address: string | null): string {
  return `${column}:${address}`
}

/** Preserve the terminal projection's exact ISO/SQLite recency contract, including future dates. */
export function isRecentPresentationDispatch(dispatch: DispatchContextRow, now: number): boolean {
  if (!dispatch.completed_at || dispatch.status === 'pending' || dispatch.status === 'dispatched') {
    return false
  }
  const completedAt = Date.parse(
    dispatch.completed_at.includes('T')
      ? dispatch.completed_at
      : `${dispatch.completed_at.replace(' ', 'T')}Z`
  )
  return Number.isFinite(completedAt) && now - completedAt <= AGENT_STATUS_STALE_AFTER_MS
}

/** Active first, otherwise latest per address; an older eligible completion never resurfaces. */
export function listSessionDispatchesForPresentation(
  this: OrchestrationDb,
  now: number
): { dispatch: DispatchContextRow; order: number }[] {
  const lowerBound = new Date(now - AGENT_STATUS_STALE_AFTER_MS - 86_400_000).toISOString()
  const rawCandidates = this.db
    .prepare(`
    SELECT rowid AS presentation_order, ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
      INDEXED BY idx_dispatch_session_presentation
      WHERE assignee_orca_session_id IS NOT NULL AND status IN ('pending', 'dispatched')
    UNION ALL
    SELECT rowid AS presentation_order, ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
      INDEXED BY idx_dispatch_session_presentation
      WHERE assignee_orca_session_id IS NOT NULL
        AND status IN ('completed', 'failed', 'circuit_broken') AND completed_at >= ?
  `)
    .all(lowerBound)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The complete schema-pinned Dispatch projection restores the persisted-row contract; the default integer wrapper normalizes rowid to a safe number.
  const candidates = rawCandidates as (DispatchContextRow & { presentation_order: number })[]
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

export function getActiveDispatchForTerminal(
  this: OrchestrationDb,
  handle: string,
  // Pane identity still resolves Dispatches after handle remint.
  assigneePaneKey?: string
): DispatchContextRow | undefined {
  return this.findActiveDispatchForAssignee(handle, assigneePaneKey)
}

/** Cache emptiness to skip per-terminal queries; inserts set true and resets invalidate it. */

export function hasAnyDispatchContexts(this: OrchestrationDb): boolean {
  if (this.hasAnyDispatchContextsCache === undefined) {
    const row = this.db.prepare('SELECT 1 FROM dispatch_contexts LIMIT 1').get()
    this.hasAnyDispatchContextsCache = row !== undefined
  }
  return this.hasAnyDispatchContextsCache
}

export function getActiveDispatchForIdentity(
  this: OrchestrationDb,
  handle: string,
  paneKey?: string
): DispatchContextRow | undefined {
  return this.findActiveDispatchForAssignee(handle, paneKey)
}

export function getActiveDispatchMailboxOwners(
  this: OrchestrationDb,
  handle: string,
  paneKey?: string
): DispatchContextRow[] {
  const byHandle = this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE assignee_handle = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC`
    )
    .all(handle) as DispatchContextRow[]
  if (byHandle.length > 0 || !paneKey) {
    return byHandle
  }

  const byExactPane = this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE assignee_pane_key = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC`
    )
    .all(paneKey) as DispatchContextRow[]
  if (byExactPane.length > 0 || !parsePaneKey(paneKey)) {
    return byExactPane
  }
  return (
    this.db
      .prepare(
        `SELECT * FROM dispatch_contexts
         WHERE assignee_pane_key IS NOT NULL
           AND status IN ('pending', 'dispatched') AND instr(assignee_pane_key, ':') > 1
           AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
         ORDER BY rowid DESC`
      )
      .all(paneKeyMatchSuffix(paneKey)) as DispatchContextRow[]
  ).filter(
    (dispatch) =>
      dispatch.assignee_pane_key !== null &&
      isEquivalentPaneKey(dispatch.assignee_pane_key, paneKey)
  )
}

export function isDispatchMessageSender(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    handle: string
    paneKey?: string | null
    allowCanonicalDispatchHandle?: boolean
  }
): boolean {
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch || !['pending', 'dispatched'].includes(dispatch.status)) {
    return false
  }
  if (params.allowCanonicalDispatchHandle && params.handle === `dispatch:${dispatch.id}`) {
    return true
  }
  if (
    params.paneKey &&
    dispatch.assignee_pane_key &&
    isEquivalentPaneKey(dispatch.assignee_pane_key, params.paneKey)
  ) {
    return true
  }
  return (
    params.handle === dispatch.assignee_handle && (!params.paneKey || !dispatch.assignee_pane_key)
  )
}

export function findActiveDispatchForAssignee(
  this: OrchestrationDb,
  assigneeHandle: string,
  assigneePaneKey?: string
): DispatchContextRow | undefined {
  const byHandle = this.db.prepare(ACTIVE_DISPATCH_BY_HANDLE_SQL).get(assigneeHandle) as
    | DispatchContextRow
    | undefined
  if (byHandle) {
    return byHandle
  }

  if (!assigneePaneKey) {
    return undefined
  }

  const exactPane = this.db.prepare(ACTIVE_DISPATCH_BY_PANE_KEY_SQL).get(assigneePaneKey) as
    | DispatchContextRow
    | undefined
  if (exactPane) {
    return exactPane
  }
  if (!parsePaneKey(assigneePaneKey)) {
    return undefined
  }
  return this.db
    .prepare(ACTIVE_DISPATCH_BY_PANE_SUFFIX_SQL)
    .get(paneKeyMatchSuffix(assigneePaneKey)) as DispatchContextRow | undefined
}

export function getLatestDispatchForTerminal(
  this: OrchestrationDb,
  handle: string
): DispatchContextRow | undefined {
  return this.db.prepare(LATEST_DISPATCH_BY_HANDLE_SQL).get(handle) as
    | DispatchContextRow
    | undefined
}

export type DispatchLookupMethods = {
  getActiveDispatchForTerminal: typeof getActiveDispatchForTerminal
  hasAnyDispatchContexts: typeof hasAnyDispatchContexts
  getActiveDispatchForIdentity: typeof getActiveDispatchForIdentity
  getActiveDispatchMailboxOwners: typeof getActiveDispatchMailboxOwners
  isDispatchMessageSender: typeof isDispatchMessageSender
  findActiveDispatchForAssignee: typeof findActiveDispatchForAssignee
  listSessionDispatchesForPresentation: typeof listSessionDispatchesForPresentation
  getLatestDispatchForTerminal: typeof getLatestDispatchForTerminal
}

export function attachDispatchLookup(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getActiveDispatchForTerminal,
    hasAnyDispatchContexts,
    getActiveDispatchForIdentity,
    getActiveDispatchMailboxOwners,
    isDispatchMessageSender,
    findActiveDispatchForAssignee,
    getLatestDispatchForTerminal,
    listSessionDispatchesForPresentation
  })
}
