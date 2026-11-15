import { listSessionDispatchesForPresentation } from './dispatch-presentation'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { DispatchContextRow } from '../orchestration-records'
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

export function hasRecordedStructuredWorkerSession(
  this: OrchestrationDb,
  session: string,
  process: string
): boolean {
  return Boolean(
    this.db
      .prepare(`SELECT 1 FROM dispatch_contexts
    WHERE assignee_orca_session_id = ? AND process_incarnation = ? LIMIT 1`)
      .get(session, process)
  )
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
  hasRecordedStructuredWorkerSession: typeof hasRecordedStructuredWorkerSession
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
    hasRecordedStructuredWorkerSession,
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
