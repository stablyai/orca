import type SyncDatabase from '../sqlite/sync-database'
import { cjkColumns } from './session-search-cjk-match'
import {
  SESSION_SEARCH_SNIPPET_MARK_CLOSE,
  SESSION_SEARCH_SNIPPET_MARK_OPEN
} from './session-search-engine-types'
import {
  andExpression,
  orExpression,
  phraseExpression,
  scopedExpression,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import type { SessionSearchRoute, SessionSearchScope } from './session-search-engine-types'

// Private markers avoid treating literal transcript brackets as highlights.
const MARK_OPEN = '\uE000'
const MARK_CLOSE = '\uE001'

const SNIPPET_TOKENS = 12
// A single FTS5 token can exceed the snippet’s character budget.
const SNIPPET_MAX_CHARS = 512

export type SessionSearchSnippet = {
  text: string
  truncated: boolean
}

export const EMPTY_SNIPPET: SessionSearchSnippet = { text: '', truncated: false }

/** Use the effective retrieval expression so phrase and typo-repaired highlights match the hit. */
export function sessionSearchSnippet(
  db: SyncDatabase,
  scope: SessionSearchScope,
  rowid: number,
  plan: SessionSearchQueryPlan,
  route: SessionSearchRoute
): SessionSearchSnippet {
  if (plan.cjkMatched) {
    return cjkSnippet(db, scope, rowid, plan.cjkRuns)
  }
  // Prefer prose over identifier fragments; -1 covers shadow-only matches.
  // The MATCH expression already restricts columns to the requested scope.
  const columns = [0, 1, 2, -1]
  // Compare marked and plain renderings so content cannot pose as a highlight.
  const select = columns
    .flatMap((column, index) => [
      `snippet(messages_fts, ${column}, '${MARK_OPEN}', '${MARK_CLOSE}', '…', ${SNIPPET_TOKENS}) AS c${index}`,
      `snippet(messages_fts, ${column}, '', '', '…', ${SNIPPET_TOKENS}) AS p${index}`
    ])
    .join(', ')
  try {
    // FTS5 needs a subselect to honor the bound rowid alongside MATCH.
    // A purge can leave orphaned messages between reads; require a live session.
    const row = db
      .prepare(
        `SELECT ${select} FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_fts MATCH ? AND messages_fts.rowid IN (SELECT ?)`
      )
      .get(scopedExpression(scope, routeExpression(plan, route)), rowid)
    if (!isSnippetRow(row)) {
      return EMPTY_SNIPPET
    }
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

const CJK_SNIPPET_RADIUS = 48

/**
 * The CJK route matches by substring, which FTS5's `snippet()` cannot show for
 * a query shorter than a trigram, so the window is cut from the stored text.
 */
function cjkSnippet(
  db: SyncDatabase,
  scope: SessionSearchScope,
  rowid: number,
  runs: readonly string[]
): SessionSearchSnippet {
  const columns = cjkColumns(scope)
  try {
    const row = db
      .prepare(
        `SELECT ${columns.map((column) => `messages_cjk_fts.${column} AS ${column}`).join(', ')}
         FROM messages_cjk_fts
         JOIN messages m ON m.id = messages_cjk_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_cjk_fts.rowid = ?`
      )
      .get(rowid)
    if (!isSnippetRow(row)) {
      return EMPTY_SNIPPET
    }
    const marker = new RegExp([...runs].sort((a, b) => b.length - a.length).join('|'), 'gu')
    for (const column of columns) {
      const text = row[column] ?? ''
      const first = text.search(marker)
      if (first === -1) {
        continue
      }
      return renderSnippet(cjkWindowPieces(text, first, marker))
    }
    return EMPTY_SNIPPET
  } catch {
    return EMPTY_SNIPPET
  }
}

function cjkWindowPieces(text: string, first: number, marker: RegExp): SnippetPiece[] {
  let start = Math.max(0, first - CJK_SNIPPET_RADIUS)
  let end = Math.min(text.length, first + CJK_SNIPPET_RADIUS * 2)
  // Never cut a surrogate pair in half.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) {
    start--
  }
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) {
    end--
  }
  const pieces: SnippetPiece[] = []
  const window = text.slice(start, end)
  let at = 0
  for (const match of window.matchAll(marker)) {
    const from = match.index
    pieces.push(
      { kind: 'text', value: (at === 0 && start > 0 ? '…' : '') + window.slice(at, from) },
      { kind: 'mark', value: MARK_OPEN },
      { kind: 'text', value: match[0] },
      { kind: 'mark', value: MARK_CLOSE }
    )
    at = from + match[0].length
  }
  pieces.push({ kind: 'text', value: window.slice(at) + (end < text.length ? '…' : '') })
  return pieces
}

function isSnippetRow(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((column) => typeof column === 'string')
  )
}

function routeExpression(plan: SessionSearchQueryPlan, route: SessionSearchRoute): string {
  if (route.endsWith('phrase')) {
    return phraseExpression(plan.phrase)
  }
  if (route.endsWith('and')) {
    return andExpression(plan.phrase)
  }
  return orExpression(plan.terms)
}

type SnippetPiece = { kind: 'text'; value: string } | { kind: 'mark'; value: string }

/** Compare against plain text to preserve literal private-use glyphs; reject unexplained differences. */
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

/** Count content code points only and discard any highlight crossing the character ceiling. */
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
