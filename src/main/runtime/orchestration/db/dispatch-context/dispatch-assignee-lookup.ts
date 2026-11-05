import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { DispatchContextRow } from '../../types'
import { DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL, paneKeyMatchSuffix } from '../pane-key-match'
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
export const LATEST_DISPATCH_BY_HANDLE_SQL = `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE assignee_handle = ? ORDER BY rowid DESC LIMIT 1`
const LATEST_DISPATCH_BY_PANE_KEY_SQL = `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE assignee_pane_key = ? ORDER BY rowid DESC LIMIT 1`
const LATEST_DISPATCH_BY_PANE_SUFFIX_SQL = `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
       WHERE assignee_pane_key IS NOT NULL AND instr(assignee_pane_key, ':') > 1
         AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
       ORDER BY rowid DESC LIMIT 1`

type AssigneeLookupSql = { byHandle: string; byPaneKey: string; byPaneSuffix: string }

const ASSIGNEE_SQL: Record<'active' | 'latest', AssigneeLookupSql> = {
  active: {
    byHandle: ACTIVE_DISPATCH_BY_HANDLE_SQL,
    byPaneKey: ACTIVE_DISPATCH_BY_PANE_KEY_SQL,
    byPaneSuffix: ACTIVE_DISPATCH_BY_PANE_SUFFIX_SQL
  },
  latest: {
    byHandle: LATEST_DISPATCH_BY_HANDLE_SQL,
    byPaneKey: LATEST_DISPATCH_BY_PANE_KEY_SQL,
    byPaneSuffix: LATEST_DISPATCH_BY_PANE_SUFFIX_SQL
  }
}

/** By handle, then exact pane, then the pane's stable leaf, newest first. */
export function findDispatchForAssignee(
  db: OrchestrationDb,
  which: 'active' | 'latest',
  assigneeHandle: string,
  assigneePaneKey: string | undefined
): DispatchContextRow | undefined {
  const sql = ASSIGNEE_SQL[which]
  const read = (statement: string, value: string) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each statement selects the schema-pinned Dispatch projection.
    db.db.prepare(statement).get(value) as DispatchContextRow | undefined
  const byHandle = read(sql.byHandle, assigneeHandle)
  if (byHandle || !assigneePaneKey) {
    return byHandle
  }
  const exactPane = read(sql.byPaneKey, assigneePaneKey)
  if (exactPane || !parsePaneKey(assigneePaneKey)) {
    return exactPane
  }
  return read(sql.byPaneSuffix, paneKeyMatchSuffix(assigneePaneKey))
}
