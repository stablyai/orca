import type SyncDatabase from '../sqlite/sync-database'
import {
  SESSION_SEARCH_SNIPPET_MARK_CLOSE,
  SESSION_SEARCH_SNIPPET_MARK_OPEN
} from './session-search-engine-types'
import { orExpression, type SessionSearchQueryPlan } from './session-search-query-planner'

const SNIPPET_TOKENS = 12
// Why a ceiling on top of the token count: a transcript chunk can be 8000
// characters with no separator in it, which FTS5 reports as one token, so
// "twelve tokens" is not by itself a bound on what a hit carries.
const SNIPPET_MAX_CHARS = 512

export type SessionSearchSnippet = {
  text: string
  truncated: boolean
}

export const EMPTY_SNIPPET: SessionSearchSnippet = { text: '', truncated: false }

/**
 * The window of one message that shows why it matched.
 *
 * The expression is the plan's OR form rather than the route's, so a hit found
 * through typo repair is marked with the repaired terms it was actually
 * retrieved by, and a phrase hit still marks each of its words.
 */
export function sessionSearchSnippet(
  db: SyncDatabase,
  table: 'messages_fts' | 'conversation_fts',
  rowid: number,
  plan: SessionSearchQueryPlan
): SessionSearchSnippet {
  // Why: the identifier shadow column is word soup; a hit that also matches in a
  // prose column should be shown from there. Column -1 (any column) is the
  // fallback for rows that only matched through the shadow column.
  const columns = table === 'messages_fts' ? [0, 1, 2, -1] : [0, 1, -1]
  const select = columns
    .map(
      (column, index) =>
        `snippet(${table}, ${column}, '${SESSION_SEARCH_SNIPPET_MARK_OPEN}', '${SESSION_SEARCH_SNIPPET_MARK_CLOSE}', '…', ${SNIPPET_TOKENS}) AS c${index}`
    )
    .join(', ')
  try {
    // Why the subselect: a bound `rowid = ?` or `rowid IN (?)` next to MATCH is
    // silently ignored by the FTS5 planner, which then returns the first match
    // in the table. Why the join to `sessions`: retrieval proved this rowid
    // belonged to a live session, but a purge can commit between that statement
    // and this one, and a message row outlives its session row until the drain
    // reaches it. INNER, never LEFT — this is the last read before content is
    // returned to a caller.
    const row = db
      .prepare(
        `SELECT ${select} FROM ${table}
         JOIN messages m ON m.id = ${table}.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE ${table} MATCH ? AND ${table}.rowid IN (SELECT ?)`
      )
      .get(orExpression(plan.terms), rowid) as Record<string, string> | undefined
    if (!row) {
      return EMPTY_SNIPPET
    }
    // A snippet with nothing highlighted tells the user nothing; omit it.
    const marked = columns
      .map((_column, index) => row[`c${index}`])
      .find((text) => text?.includes(SESSION_SEARCH_SNIPPET_MARK_OPEN))
    return marked === undefined ? EMPTY_SNIPPET : truncateSnippet(marked)
  } catch {
    return EMPTY_SNIPPET
  }
}

/** Cut on a code-point boundary, and never between `[[` and its `]]`. */
export function truncateSnippet(text: string): SessionSearchSnippet {
  if (text.length <= SNIPPET_MAX_CHARS) {
    return { text, truncated: false }
  }
  const points = [...text]
  if (points.length <= SNIPPET_MAX_CHARS) {
    return { text, truncated: false }
  }
  const cut = points.slice(0, SNIPPET_MAX_CHARS).join('')
  const opened = cut.lastIndexOf(SESSION_SEARCH_SNIPPET_MARK_OPEN)
  // An open mark with no close hands the renderer something it can never close.
  const balanced =
    opened !== -1 && !cut.includes(SESSION_SEARCH_SNIPPET_MARK_CLOSE, opened)
      ? cut.slice(0, opened)
      : cut
  return { text: balanced, truncated: true }
}
