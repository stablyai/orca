import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchScope } from './session-search-engine-types'
import type { MessageRow } from './session-search-hit-ranking'
import { scopedExpression } from './session-search-query-planner'

const EXAMINED_POSTINGS_LIMIT = 10_000
export const SESSION_SEARCH_MESSAGE_CANDIDATES = 2000

type PostingWindow = {
  rows: MessageRow[]
  after: number | null
  complete: boolean
}

/** One request shares its index work across retrieval routes and spelling probes. */
export class SessionSearchPostings {
  private remaining = EXAMINED_POSTINGS_LIMIT
  private readonly windows = new Map<string, PostingWindow>()
  exhausted = false

  constructor(
    private readonly db: SyncDatabase,
    private readonly scope: SessionSearchScope,
    private readonly acceptsSession: (id: number) => boolean = () => true
  ) {}

  private examinePosting(): boolean {
    // The first row beyond the shared budget is the request's only exhaustion probe.
    if (this.remaining === 0) {
      this.exhausted = true
      return false
    }
    this.remaining--
    return true
  }

  *matching(expression: string): Generator<MessageRow> {
    let window = this.windows.get(expression)
    if (!window) {
      window = { rows: [], after: null, complete: false }
      this.windows.set(expression, window)
    }
    // Why: an own-term probe and its later retrieval must share the already-examined window.
    yield* window.rows
    if (window.complete || this.exhausted) {
      return
    }
    const statement = this.db.prepare(
      `SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
       ${window.after === null ? '' : 'AND rowid < CAST(? AS INTEGER)'} ORDER BY rowid DESC`
    )
    const values = window.after === null ? [expression] : [expression, window.after]
    const message = this.db.prepare(
      `SELECT m.id AS rowid, m.session_row_id, m.role, m.ts FROM messages m
       JOIN sessions s ON s.id = m.session_row_id WHERE m.id = ? AND m.role != 'tool'`
    )
    const scoped = this.db.prepare(
      'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid IN (SELECT ?)'
    )
    for (const posting of statement.iterate(...values)) {
      if (!this.examinePosting()) {
        return
      }
      window.after = Number(posting.rowid)
      const row = message.get(window.after)
      if (!row || !this.acceptsSession(Number(row.session_row_id))) {
        continue
      }
      if (
        this.scope === 'conversation' &&
        !scoped.get(scopedExpression(this.scope, expression), window.after)
      ) {
        continue
      }
      const match: MessageRow = {
        rowid: window.after,
        session_row_id: Number(row.session_row_id),
        role: String(row.role),
        ts: typeof row.ts === 'string' ? row.ts : null,
        score: 0
      }
      window.rows.push(match)
      yield match
    }
    window.complete = true
  }
}
