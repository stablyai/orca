import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { DispatchContextRow } from '../../types'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  isEquivalentPaneKey,
  paneKeyMatchSuffix
} from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../row-column-lists'
import {
  activeDispatchMailboxBranch,
  equivalentDispatchMailboxOwners
} from '../dispatch-mailbox-selection'

// Hoist explicit projections so graph-publish queries hit the statement cache; newest first, since
// one handle can hold several active Dispatches.
const assigneeSql = (where: string, status: string) =>
  `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE ${where} ${status} ORDER BY rowid DESC LIMIT 1`
const BY_PANE_SUFFIX = `assignee_pane_key IS NOT NULL AND instr(assignee_pane_key, ':') > 1
         AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?`
const assigneeLookups = (status: string) => ({
  byHandle: assigneeSql('assignee_handle = ?', status),
  byPaneKey: assigneeSql('assignee_pane_key = ?', status),
  byPaneSuffix: assigneeSql(BY_PANE_SUFFIX, status)
})
const ASSIGNEE_SQL = {
  active: assigneeLookups("AND status IN ('pending', 'dispatched')"),
  latest: assigneeLookups('')
}

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
  const rawByHandle = this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE assignee_handle = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC`
    )
    .all(handle)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * reads the schema-owned Dispatch row; the statement wrapper normalizes integer fields.
  const byHandle = rawByHandle as DispatchContextRow[]
  if (activeDispatchMailboxBranch(byHandle, paneKey) === 'handle') {
    return byHandle
  }

  const rawByExactPane = this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE assignee_pane_key = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC`
    )
    .all(paneKey!)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * reads the schema-owned Dispatch row; the statement wrapper normalizes integer fields.
  const byExactPane = rawByExactPane as DispatchContextRow[]
  if (activeDispatchMailboxBranch(byHandle, paneKey, byExactPane) === 'pane') {
    return byExactPane
  }
  const rawByPaneSuffix = this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
         WHERE assignee_pane_key IS NOT NULL
           AND status IN ('pending', 'dispatched') AND instr(assignee_pane_key, ':') > 1
           AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
         ORDER BY rowid DESC`
    )
    .all(paneKeyMatchSuffix(paneKey!))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * reads the schema-owned Dispatch row; the statement wrapper normalizes integer fields.
  const byPaneSuffix = rawByPaneSuffix as DispatchContextRow[]
  return equivalentDispatchMailboxOwners(byPaneSuffix, paneKey!)
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
  return isDispatchAssignee(dispatch, params.handle, params.paneKey)
}

/** Whether this handle or pane was given the Dispatch, whatever its status. */
export function isDispatchAssignee(
  dispatch: Pick<DispatchContextRow, 'assignee_handle' | 'assignee_pane_key'>,
  handle: string,
  paneKey: string | null | undefined
): boolean {
  if (
    paneKey &&
    dispatch.assignee_pane_key &&
    isEquivalentPaneKey(dispatch.assignee_pane_key, paneKey)
  ) {
    return true
  }
  return handle === dispatch.assignee_handle && (!paneKey || !dispatch.assignee_pane_key)
}

export function findActiveDispatchForAssignee(
  this: OrchestrationDb,
  assigneeHandle: string,
  assigneePaneKey?: string
): DispatchContextRow | undefined {
  return findDispatchForAssignee(this, 'active', assigneeHandle, assigneePaneKey)
}

/** The newest Dispatch, settled or not; with a pane, also after the handle was reminted. */
export function getLatestDispatchForTerminal(
  this: OrchestrationDb,
  handle: string,
  paneKey?: string
): DispatchContextRow | undefined {
  return findDispatchForAssignee(this, 'latest', handle, paneKey)
}

function findDispatchForAssignee(
  db: OrchestrationDb,
  kind: keyof typeof ASSIGNEE_SQL,
  handle: string,
  paneKey: string | undefined
): DispatchContextRow | undefined {
  const sql = ASSIGNEE_SQL[kind]
  const read = (statement: string, value: string) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each statement selects the schema-pinned Dispatch projection.
    db.db.prepare(statement).get(value) as DispatchContextRow | undefined
  const byHandle = read(sql.byHandle, handle)
  if (byHandle || !paneKey) {
    return byHandle
  }
  const exactPane = read(sql.byPaneKey, paneKey)
  if (exactPane || !parsePaneKey(paneKey)) {
    return exactPane
  }
  return read(sql.byPaneSuffix, paneKeyMatchSuffix(paneKey))
}

/** Helpers this Dispatch started that have not settled; their reports wake their creator. */
export function hasOpenHelperDispatch(this: OrchestrationDb, dispatchId: string): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM dispatch_contexts
         WHERE creator_dispatch_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`
      )
      .get(dispatchId) !== undefined
  )
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
  hasOpenHelperDispatch: typeof hasOpenHelperDispatch
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
    hasOpenHelperDispatch,
    listSessionDispatchesForPresentation
  })
}
