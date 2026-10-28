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
    getLatestDispatchForTerminal
  })
}
