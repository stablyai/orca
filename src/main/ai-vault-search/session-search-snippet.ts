import type SyncDatabase from '../sqlite/sync-database'
import {
  SESSION_SEARCH_SNIPPET_MARK_CLOSE,
  SESSION_SEARCH_SNIPPET_MARK_OPEN
} from './session-search-engine-types'
import {
  orExpression,
  scopedExpression,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import type { SessionSearchScope } from './session-search-engine-types'

// What FTS5 wraps a match in before this module rewrites it to the public
// marks. Private-use code points, and not `[[`, because two different jobs here
// have to tell a mark from content: choosing the column to show, and refusing
// to cut a snippet between an open mark and its close. Transcripts contain
// `[[` — a bash `[[ -f x ]]`, numpy's `[[1, 2]]` — and a mark the content can
// forge makes both of those decisions wrong on real text.
const MARK_OPEN = '\uE000'
const MARK_CLOSE = '\uE001'

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
  scope: SessionSearchScope,
  rowid: number,
  plan: SessionSearchQueryPlan
): SessionSearchSnippet {
  // Why: the identifier shadow column is word soup; a hit that also matches in a
  // prose column should be shown from there. Column -1 (any column) is the
  // fallback for rows that only matched through the shadow column.
  //
  // The same four for every scope, because the scope is already in the
  // expression below. A conversation snippet cannot come out of `tool_text` for
  // the reason the search could not: the row has to match
  // `{user_text assistant_text}: …` before any of these columns is read, and a
  // row that matches under that filter carries its mark in column 0 or 1. A
  // second list here would be a guard with nothing left to guard, and the two
  // would mask each other's mistakes.
  const columns = [0, 1, 2, -1]
  // Each column twice: once marked, once with empty marks. Whether a column
  // matched is then the difference between two renderings of the same text,
  // which content cannot forge — searching the marked one for a mark reads a
  // transcript's own `[[` as a highlight and shows a column that matched
  // nothing.
  const select = columns
    .flatMap((column, index) => [
      `snippet(messages_fts, ${column}, '${MARK_OPEN}', '${MARK_CLOSE}', '…', ${SNIPPET_TOKENS}) AS c${index}`,
      `snippet(messages_fts, ${column}, '', '', '…', ${SNIPPET_TOKENS}) AS p${index}`
    ])
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
        `SELECT ${select} FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_fts MATCH ? AND messages_fts.rowid IN (SELECT ?)`
      )
      .get(scopedExpression(scope, orExpression(plan.terms)), rowid) as
      | Record<string, string>
      | undefined
    if (!row) {
      return EMPTY_SNIPPET
    }
    // A snippet with nothing highlighted tells the user nothing; omit it.
    const marked = columns
      .map((_column, index) => row[`c${index}`])
      .find((text, index) => text !== undefined && text !== row[`p${index}`])
    return marked === undefined ? EMPTY_SNIPPET : publicMarks(truncateSnippet(marked))
  } catch {
    return EMPTY_SNIPPET
  }
}

/** The internal marks, swapped for the ones a caller sees, once and at the end. */
function publicMarks(snippet: SessionSearchSnippet): SessionSearchSnippet {
  return {
    ...snippet,
    text: snippet.text
      .replaceAll(MARK_OPEN, SESSION_SEARCH_SNIPPET_MARK_OPEN)
      .replaceAll(MARK_CLOSE, SESSION_SEARCH_SNIPPET_MARK_CLOSE)
  }
}

/** Cut on a code-point boundary, and never between a mark and its close. */
export function truncateSnippet(text: string): SessionSearchSnippet {
  if (text.length <= SNIPPET_MAX_CHARS) {
    return { text, truncated: false }
  }
  const points = [...text]
  if (points.length <= SNIPPET_MAX_CHARS) {
    return { text, truncated: false }
  }
  const cut = points.slice(0, SNIPPET_MAX_CHARS).join('')
  const opened = cut.lastIndexOf(MARK_OPEN)
  // An open mark with no close hands the renderer something it can never close.
  const balanced = opened !== -1 && !cut.includes(MARK_CLOSE, opened) ? cut.slice(0, opened) : cut
  return { text: balanced, truncated: true }
}
