import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchRoute, SessionSearchScope } from './session-search-engine-types'
import type { MessageRow, SessionRow } from './session-search-hit-ranking'
import {
  andExpression,
  orExpression,
  phraseExpression,
  planSessionSearchQuery,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import type { SessionRowFilter } from './session-search-row-filter'
import { VISIBLE_MESSAGES, VISIBLE_SESSIONS } from './session-search-schema'
import { SessionSearchTypoRepair } from './session-search-typo-repair'

// Measured: user 3 / assistant 2 / tool 1 / identifiers 1 (MRR 0.503 vs 0.475 flat).
const FULL_WEIGHTS = '3.0, 2.0, 1.0, 1.0'
const CONVERSATION_WEIGHTS = '3.0, 2.0'

export type RetrievalScope = {
  scope: SessionSearchScope
  sort: 'relevance' | 'newest'
  filter: SessionRowFilter
  /**
   * Sessions retrieved before ranking cuts the page. See
   * docs/reference/agent-session-search-query-tuning.md for the measurements
   * behind the default; it is an option because the right value depends on how
   * large an index is and no single number is right for every host.
   */
  candidateLimit: number
}

export type Retrieved = {
  rows: MessageRow[]
  route: SessionSearchRoute
  /** The plan the rows were actually retrieved by; snippets highlight from it. */
  plan: SessionSearchQueryPlan
  repairedTerms?: string[]
}

export function ftsTableFor(scope: SessionSearchScope): 'messages_fts' | 'conversation_fts' {
  return scope === 'all' ? 'messages_fts' : 'conversation_fts'
}

/** The FTS half of a search: the route ladder and the SQL each rung runs. */
export class SessionSearchRetrieval {
  private readonly typoRepair: SessionSearchTypoRepair

  constructor(private readonly db: SyncDatabase) {
    this.typoRepair = new SessionSearchTypoRepair(db)
  }

  /**
   * The route ladder: phrase, then AND for a literal-looking query, then typo
   * repair, then OR.
   *
   * Repair runs before the OR fallback rather than after it fails. A typo next
   * to a common word would otherwise be masked: the common word alone retrieves
   * plenty of rows over OR, so nothing would ever look like a miss worth
   * repairing.
   */
  run(plan: SessionSearchQueryPlan, scope: RetrievalScope): Retrieved {
    const exact = this.literal(plan, scope)
    if (exact) {
      return { ...exact, plan }
    }
    const repaired = this.repair(plan)
    const effective = repaired ?? plan
    const literal = repaired ? this.literal(repaired, scope) : null
    const found = literal ?? {
      rows: this.match(orExpression(effective.terms), scope),
      route: 'or' as const
    }
    return {
      rows: found.rows,
      route: repaired ? (`typo+${found.route}` as SessionSearchRoute) : found.route,
      plan: effective,
      ...(repaired ? { repairedTerms: repaired.body } : {})
    }
  }

  /** Newest sessions the constraints allow: what an operator-only query names. */
  recent(scope: RetrievalScope): SessionRow[] {
    const { conditions, values } = scope.filter
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return this.db
      .prepare(
        `SELECT * FROM ${VISIBLE_SESSIONS} ${where} ORDER BY updated_at DESC LIMIT ${scope.candidateLimit}`
      )
      .all(...values) as SessionRow[]
  }

  loadSessions(ids: readonly number[], filter: SessionRowFilter): SessionRow[] {
    if (ids.length === 0) {
      return []
    }
    const conditions = [`id IN (${ids.map(() => '?').join(',')})`, ...filter.conditions]
    return this.db
      .prepare(`SELECT * FROM ${VISIBLE_SESSIONS} WHERE ${conditions.join(' AND ')}`)
      .all(...ids, ...filter.values) as SessionRow[]
  }

  private repair(plan: SessionSearchQueryPlan): SessionSearchQueryPlan | null {
    let changed = false
    const body = plan.body.map((term) => {
      const fix = this.typoRepair.correct(term)
      if (fix && fix !== term.toLowerCase()) {
        changed = true
        return fix
      }
      return term
    })
    return changed ? { ...planSessionSearchQuery(body.join(' ')), literal: plan.literal } : null
  }

  /** Phrase, then AND, for literal-looking queries; null when neither matches. */
  private literal(
    plan: SessionSearchQueryPlan,
    scope: RetrievalScope
  ): { rows: MessageRow[]; route: 'phrase' | 'and' } | null {
    if (!plan.literal || plan.body.length === 0) {
      return null
    }
    // A one-token literal (`resolveTerminalPath`, `src/a/b.ts`) is its own
    // phrase: the tokenizer keeps it whole, so the exact token is the cheap,
    // precise first try before the identifier pieces fan out over OR.
    const phrase = this.match(phraseExpression(plan.body), scope)
    if (phrase.length > 0) {
      return { rows: phrase, route: 'phrase' }
    }
    if (plan.body.length < 2) {
      return null
    }
    const and = this.match(andExpression(plan.body), scope)
    return and.length > 0 ? { rows: and, route: 'and' } : null
  }

  private match(expression: string, scope: RetrievalScope): MessageRow[] {
    const { filter, sort, candidateLimit } = scope
    const eligible = filter.conditions.length
      ? ` AND m.session_row_id IN (SELECT id FROM ${VISIBLE_SESSIONS} WHERE ${filter.conditions.join(' AND ')})`
      : ''
    const table = ftsTableFor(scope.scope)
    const weights = scope.scope === 'all' ? FULL_WEIGHTS : CONVERSATION_WEIGHTS
    const matched = `SELECT ${table}.rowid AS rowid, -bm25(${table}, ${weights}) AS score,
      m.session_row_id, m.role, m.ts, s.updated_at
      FROM ${table} JOIN ${VISIBLE_MESSAGES} m ON m.id = ${table}.rowid
      JOIN ${VISIBLE_SESSIONS} s ON s.id = m.session_row_id WHERE ${table} MATCH ?${eligible}`
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
    return this.db.prepare(sql).all(expression, ...filter.values) as MessageRow[]
  }
}
