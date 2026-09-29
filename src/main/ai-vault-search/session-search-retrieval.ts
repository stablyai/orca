import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchRoute, SessionSearchScope } from './session-search-engine-types'
import type { MessageRow, SessionRow } from './session-search-hit-ranking'
import {
  andExpression,
  orExpression,
  phraseExpression,
  planSessionSearchQuery,
  scopedExpression,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import type { SessionRowFilter } from './session-search-row-filter'
import { SessionSearchTypoRepair } from './session-search-typo-repair'

// The operator-only walk: rows per page, and how far past a full candidate set
// it will read before giving up on finding more matches.
const RECENT_PAGE_ROWS = 512
// Ids per `loadSessions` statement, with room to spare for the filter's own
// bound values beside them.
const SESSION_ID_BATCH = 500
const RECENT_SCAN_FACTOR = 20

// Measured: user 3 / assistant 2 / tool 1 / identifiers 1 (MRR 0.503 vs 0.475 flat).
const FULL_WEIGHTS = '3.0, 2.0, 1.0, 1.0'
// Tool and identifier columns do not contribute to conversation ranking.
const CONVERSATION_WEIGHTS = '3.0, 2.0, 0.0, 0.0'

export type RetrievalScope = {
  scope: SessionSearchScope
  sort: 'relevance' | 'newest'
  filter: SessionRowFilter
  /**
   * `repo:` / `path:`, which SQL cannot express. Applied over retrieved rows;
   * see session-search-row-filter for why it cannot be pushed down.
   */
  matchesOperators: (session: SessionRow) => boolean
  /**
   * Sessions retrieved before ranking cuts the page. See
   * docs/reference/agent-session-search-query-tuning.md for the measurements
   * behind the default; it is an option because the right value depends on how
   * large an index is and no single number is right for every host.
   */
  candidateLimit: number
}

export type Retrieved = {
  sessions: SessionRow[]
  rows: MessageRow[]
  incomplete: boolean
  route: SessionSearchRoute
  /** The plan the rows were actually retrieved by; snippets highlight from it. */
  plan: SessionSearchQueryPlan
  repairedTerms?: string[]
}

/**
 * The bm25 weights a scope ranks with. The conversation pair stays here rather
 * than beside `scopedExpression`, because weights are a property of this SQL
 * and nothing else asks for them.
 */
export function scopedWeights(scope: SessionSearchScope): string {
  return scope === 'all' ? FULL_WEIGHTS : CONVERSATION_WEIGHTS
}

/** The FTS half of a search: the route ladder and the SQL each rung runs. */
export class SessionSearchRetrieval {
  private readonly typoRepair: SessionSearchTypoRepair

  constructor(private readonly db: SyncDatabase) {
    this.typoRepair = new SessionSearchTypoRepair(db)
  }

  /**
   * The route ladder: phrase, then AND, then typo repair, then OR.
   *
   * Repair runs before the OR fallback rather than after it fails. A typo next
   * to a common word would otherwise be masked: the common word alone retrieves
   * plenty of rows over OR, so nothing would ever look like a miss worth
   * repairing.
   */
  run(plan: SessionSearchQueryPlan, scope: RetrievalScope): Retrieved {
    let incomplete = false
    let sessions: SessionRow[] = []
    const match = (expression: string): MessageRow[] => {
      const rows = this.match(expression, scope)
      // Assigned, not accumulated: only the rung whose rows are returned can
      // say whether a cap hid anything. A phrase rung that filled the limit and
      // was then discarded describes a row set the answering rung never used.
      incomplete = rows.length >= scope.candidateLimit
      sessions = this.loadSessions(
        rows.map((row) => row.session_row_id),
        scope
      )
      const eligible = new Set(sessions.map((row) => row.id))
      return rows.filter((row) => eligible.has(row.session_row_id))
    }
    const exact = this.phraseThenAnd(plan, match)
    if (exact) {
      return { ...exact, plan, incomplete, sessions }
    }
    const repaired = this.repair(plan, scope.scope)
    const effective = repaired ?? plan
    const literal = repaired ? this.phraseThenAnd(repaired, match) : null
    const found = literal ?? {
      rows: match(orExpression(effective.terms)),
      route: 'or' as const
    }
    return {
      sessions,
      rows: found.rows,
      incomplete,
      route: repaired ? (`typo+${found.route}` as SessionSearchRoute) : found.route,
      plan: effective,
      ...(repaired ? { repairedTerms: repaired.body } : {})
    }
  }

  /**
   * Newest sessions the constraints allow: what an operator-only query names.
   *
   * Walked in pages rather than taken in one `LIMIT`, because the operators are
   * applied in JS. A single cut of the newest N would hand ranking whatever
   * happened to be recent and then throw most of it away, so `repo:x` on a busy
   * index could answer with nothing while plenty matched. The walk is bounded
   * both ways: it stops at a full candidate set, and at a ceiling on rows read.
   */
  recent(scope: RetrievalScope): { sessions: SessionRow[]; incomplete: boolean } {
    const { conditions, values } = scope.filter
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const page = this.db.prepare(
      `SELECT * FROM sessions ${where}
       ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    const ceiling = scope.candidateLimit * RECENT_SCAN_FACTOR
    const sessions: SessionRow[] = []
    let scanned = 0
    // Why the flag and not a count: both caps mean the same thing to a caller —
    // a session it never saw may have matched — and only the loop knows which
    // of them ended it. Reporting rows read instead let the engine infer
    // completeness from a full candidate set alone, so giving up at the ceiling
    // with nothing found looked exactly like a search that found nothing.
    let incomplete = false
    while (sessions.length < scope.candidateLimit) {
      if (scanned >= ceiling) {
        incomplete = true
        break
      }
      const rows = page.all(...values, RECENT_PAGE_ROWS, scanned) as SessionRow[]
      if (rows.length === 0) {
        break
      }
      scanned += rows.length
      for (const row of rows) {
        if (sessions.length < scope.candidateLimit && scope.matchesOperators(row)) {
          sessions.push(row)
        }
      }
    }
    return { sessions, incomplete: incomplete || sessions.length >= scope.candidateLimit }
  }

  /** Bound SQL parameters independently of the configurable candidate limit. */
  private loadSessions(ids: readonly number[], scope: RetrievalScope): SessionRow[] {
    const rows: SessionRow[] = []
    for (let start = 0; start < ids.length; start += SESSION_ID_BATCH) {
      const batch = ids.slice(start, start + SESSION_ID_BATCH)
      const conditions = [`id IN (${batch.map(() => '?').join(',')})`, ...scope.filter.conditions]
      rows.push(
        ...(this.db
          .prepare(`SELECT * FROM sessions WHERE ${conditions.join(' AND ')}`)
          .all(...batch, ...scope.filter.values) as SessionRow[])
      )
    }
    return rows.filter((row) => scope.matchesOperators(row))
  }

  private repair(
    plan: SessionSearchQueryPlan,
    scope: SessionSearchScope
  ): SessionSearchQueryPlan | null {
    const typoRepair = this.typoRepair
    let changed = false
    // Only the body is a candidate for a correction, but the re-plan is fed the
    // tokens as typed: re-planning the body alone would hand the phrase rung a
    // sentence with its stop words already gone, and `relay dropping frames`
    // cannot match the `relay is dropping frames` that is in the transcript.
    const repairable = new Set(plan.body.map((term) => term.toLowerCase()))
    const phrase = plan.phrase.map((token) => {
      if (!repairable.has(token.toLowerCase())) {
        return token
      }
      // Repaired inside the scope the search will run in, so a spelling only
      // tool output carries neither suppresses a repair nor becomes one.
      const fix = typoRepair.correct(token, scope)
      if (fix && fix !== token.toLowerCase()) {
        changed = true
        return fix
      }
      return token
    })
    // The repair changes spellings, not the query's character: the re-plan is
    // told what the original decided so a corrected literal keeps every term it
    // was typed with.
    return changed ? planSessionSearchQuery(phrase.join(' '), plan.literal) : null
  }

  /**
   * Phrase, then AND, over the tokens as typed; null when neither matches.
   *
   * Prose runs it too, and not only a literal-looking query. A sentence pasted
   * out of a transcript is ordinary words in order, and over OR its common
   * words fill the candidate limit with recent sessions long before the old
   * session that holds the sentence is reached, so the exact match a user can
   * see in front of them comes back missing.
   */
  private phraseThenAnd(
    plan: SessionSearchQueryPlan,
    match: (expression: string) => MessageRow[]
  ): { rows: MessageRow[]; route: 'phrase' | 'and' } | null {
    const tokens = plan.phrase
    // A one-token literal (`resolveTerminalPath`, `src/a/b.ts`) is its own
    // phrase: the tokenizer keeps it whole, so the exact token is the cheap,
    // precise first try before the identifier pieces fan out over OR. One word
    // of prose is not quoting anything, so it goes straight to OR as before.
    if (tokens.length === 0 || (tokens.length < 2 && !plan.literal)) {
      return null
    }
    const phrase = match(phraseExpression(tokens))
    if (phrase.length > 0) {
      return { rows: phrase, route: 'phrase' }
    }
    if (tokens.length < 2) {
      return null
    }
    const and = match(andExpression(tokens))
    return and.length > 0 ? { rows: and, route: 'and' } : null
  }

  private match(expression: string, scope: RetrievalScope): MessageRow[] {
    const { filter, sort, candidateLimit } = scope
    const eligible = filter.conditions.length
      ? ` AND m.session_row_id IN (SELECT id FROM sessions WHERE ${filter.conditions.join(' AND ')})`
      : ''
    const matched = `SELECT messages_fts.rowid AS rowid,
      -bm25(messages_fts, ${scopedWeights(scope.scope)}) AS score,
      m.session_row_id, m.role, m.ts, s.updated_at
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_row_id WHERE messages_fts MATCH ?${eligible}`
    // Why: collapse to one row per session BEFORE the candidate limit, on both
    // sort orders, so a single long session cannot occupy the whole page.
    // `max(score)` makes SQLite pick that session's best row for the bare columns.
    // Cost of grouping instead of a bounded top-N sorter, measured: ~1.75x
    // (49.6 vs 28.6 ms at 80k matching rows, 183.6 vs 104.1 ms at 240k) and a
    // temp b-tree over every match. No inner LIMIT can bound it: the CTE has no
    // order, so any cut drops whole sessions rather than their surplus rows.
    const order = sort === 'newest' ? 'updated_at DESC, score DESC' : 'score DESC'
    const sql = `WITH matched AS MATERIALIZED (${matched})
      SELECT rowid, max(score) AS score, session_row_id, role, ts FROM matched
      GROUP BY session_row_id ORDER BY ${order} LIMIT ${candidateLimit}`
    return this.db
      .prepare(sql)
      .all(scopedExpression(scope.scope, expression), ...filter.values) as MessageRow[]
  }
}
