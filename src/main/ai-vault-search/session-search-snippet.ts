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
    const index = columns.findIndex(
      (_column, at) => row[`c${at}`] !== undefined && row[`c${at}`] !== row[`p${at}`]
    )
    if (index === -1) {
      return EMPTY_SNIPPET
    }
    const pieces = splitMarks(row[`c${index}`]!, row[`p${index}`]!)
    return pieces === null ? EMPTY_SNIPPET : renderSnippet(pieces)
  } catch {
    return EMPTY_SNIPPET
  }
}

/** One run of the snippet's own text, or one mark FTS5 put between two runs. */
type SnippetPiece = { kind: 'text'; value: string } | { kind: 'mark'; value: string }

/**
 * The marked rendering as its text and the marks FTS5 inserted into it.
 *
 * A mark is a private-use character the marked rendering has where the plain one
 * has something else, so a Nerd Font glyph the transcript itself wrote stays
 * text — replacing every private-use character would hand the renderer a
 * highlight the content forged. Null when the two renderings differ for any
 * other reason, which is not a difference this can attribute.
 */
function splitMarks(marked: string, plain: string): SnippetPiece[] | null {
  const pieces: SnippetPiece[] = []
  const rest = [...plain]
  let at = 0
  let run = ''
  for (const point of marked) {
    if (point === rest[at]) {
      run += point
      at++
      continue
    }
    if (point !== MARK_OPEN && point !== MARK_CLOSE) {
      return null
    }
    pieces.push({ kind: 'text', value: run }, { kind: 'mark', value: point })
    run = ''
  }
  if (at !== rest.length) {
    return null
  }
  pieces.push({ kind: 'text', value: run })
  return pieces
}

/**
 * The public marks, and the character ceiling.
 *
 * Cut on a code-point boundary, and never between a mark and its close: an open
 * mark with no close hands the renderer something it can never close. The
 * ceiling counts the snippet's own characters, so the marks cost the caller
 * nothing and a transcript's own private-use character costs it one.
 */
function renderSnippet(pieces: SnippetPiece[]): SessionSearchSnippet {
  let text = ''
  let shown = 0
  let openedAt: number | null = null
  for (const piece of pieces) {
    if (piece.kind === 'mark') {
      const open = piece.value === MARK_OPEN
      openedAt = open ? text.length : null
      text += open ? SESSION_SEARCH_SNIPPET_MARK_OPEN : SESSION_SEARCH_SNIPPET_MARK_CLOSE
      continue
    }
    const points = [...piece.value]
    if (shown + points.length <= SNIPPET_MAX_CHARS) {
      shown += points.length
      text += piece.value
      continue
    }
    text += points.slice(0, SNIPPET_MAX_CHARS - shown).join('')
    return { text: openedAt === null ? text : text.slice(0, openedAt), truncated: true }
  }
  return { text, truncated: false }
}
