import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { DispatchContextRow } from '../../types'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  isEquivalentPaneKey,
  paneKeyMatchSuffix
} from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export function getActiveDispatchForTerminal(
  this: OrchestrationDb,
  handle: string,
  // Why optional: a handle reminted between dispatch and exit no longer matches
  // the row, but the pane identity behind it survives the remint.
  assigneePaneKey?: string
): DispatchContextRow | undefined {
  return this.findActiveDispatchForAssignee(handle, assigneePaneKey)
}

/**
 * Cheap "are there any dispatch rows at all" probe. When false, no terminal
 * can have an active or recent-completed dispatch, so orchestration-context
 * builders can skip their per-terminal query fan-out entirely. Cached after
 * the first probe; createDispatchContext marks it true, resets clear it.
 */

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
  const byHandle = this.db
    .prepare(
      // Why: newest-first like the pane lookups below — an unordered LIMIT 1 could pin a stale row if a handle ever has two active dispatches.
      `SELECT * FROM dispatch_contexts
       WHERE assignee_handle = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(assigneeHandle) as DispatchContextRow | undefined
  if (byHandle) {
    return byHandle
  }

  if (!assigneePaneKey) {
    return undefined
  }

  const exactPane = this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE assignee_pane_key = ? AND status IN ('pending', 'dispatched')
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(assigneePaneKey) as DispatchContextRow | undefined
  if (exactPane) {
    return exactPane
  }
  if (!parsePaneKey(assigneePaneKey)) {
    return undefined
  }
  return this.db
    .prepare(
      `SELECT * FROM dispatch_contexts
       WHERE assignee_pane_key IS NOT NULL
         AND status IN ('pending', 'dispatched') AND instr(assignee_pane_key, ':') > 1
         AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(paneKeyMatchSuffix(assigneePaneKey)) as DispatchContextRow | undefined
}

export function getLatestDispatchForTerminal(
  this: OrchestrationDb,
  handle: string
): DispatchContextRow | undefined {
  return this.db
    .prepare(
      'SELECT * FROM dispatch_contexts WHERE assignee_handle = ? ORDER BY rowid DESC LIMIT 1'
    )
    .get(handle) as DispatchContextRow | undefined
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
