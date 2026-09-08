import type SyncDatabase from '../sqlite/sync-database'
import type {
  AiVaultSearchArgs,
  AiVaultSearchHit,
  AiVaultSearchRoute
} from '../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_SNIPPET_MARK_CLOSE,
  AI_VAULT_SEARCH_SNIPPET_MARK_OPEN
} from '../../shared/ai-vault-search-types'
import { rankSessionHits, type MessageRow, type SessionRow } from './session-search-hit-ranking'
import {
  andExpression,
  orExpression,
  phraseExpression,
  planSessionSearchQuery,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import { VISIBLE_MESSAGES, VISIBLE_SESSIONS } from './session-search-schema'
import { SessionSearchTypoRepair } from './session-search-typo-repair'
import { sessionRowFilter, type SessionRowFilter } from './session-search-row-filter'
import {
  hasAiVaultSearchQueryOperators,
  splitAiVaultSearchQuery
} from '../../shared/ai-vault-search-query-operators'

// Measured: user 3 / assistant 2 / tool 1 / identifiers 1 (MRR 0.503 vs 0.475 flat).
const FULL_WEIGHTS = '3.0, 2.0, 1.0, 1.0'
const CONVERSATION_WEIGHTS = '3.0, 2.0'
// Sessions retrieved before ranking cuts the page; every page builder uses it,
// so a fork group is always weighed against the same candidate set.
const SESSION_CANDIDATE_LIMIT = 600
const SNIPPET_TOKENS = 12
// Why: single brackets are everywhere in code transcripts (`arr[0]`, regex
// classes, markdown links) and would read as matches; doubled ones are rare.
const SNIPPET_MARK_OPEN = AI_VAULT_SEARCH_SNIPPET_MARK_OPEN
const SNIPPET_MARK_CLOSE = AI_VAULT_SEARCH_SNIPPET_MARK_CLOSE

/** One search pass: the caller's args plus everything the operators decided. */
type Retrieval = {
  args: AiVaultSearchArgs
  tier: 'full' | 'conversation'
  filter: SessionRowFilter
  /** Query text with `repo:` / `path:` operators removed; what FTS sees. */
  text: string
}

export type SessionSearchExecution = {
  hits: AiVaultSearchHit[]
  route: AiVaultSearchRoute
  repairedTerms?: string[]
}

export class SessionSearchQuery {
  private readonly typoRepair: SessionSearchTypoRepair

  constructor(private readonly db: SyncDatabase) {
    this.typoRepair = new SessionSearchTypoRepair(db)
  }

  execute(args: AiVaultSearchArgs, cutoffMs: number | null = null): SessionSearchExecution {
    const split = splitAiVaultSearchQuery(args.query)
    const retrieval: Retrieval = {
      args,
      tier: args.tier ?? 'full',
      filter: sessionRowFilter(args, split, cutoffMs),
      text: split.text
    }
    const plan = planSessionSearchQuery(retrieval.text)
    if (plan.terms.length === 0) {
      // Operators with no free text still name a scope, so answer with the
      // newest sessions inside it rather than nothing.
      const hits = hasAiVaultSearchQueryOperators(split) ? this.recent(retrieval) : []
      return { hits, route: 'or' }
    }
    const exact = this.retrieveLiteral(plan, retrieval)
    if (exact) {
      return { hits: this.rollUp(exact.rows, retrieval, plan), route: exact.route }
    }
    // Why: repair runs before the OR fallback, not after it fails; a typo next
    // to a common word would otherwise be masked by the common word's hits.
    const repaired = this.repair(plan)
    const effective = repaired ?? plan
    const literal = repaired ? this.retrieveLiteral(repaired, retrieval) : null
    const result = literal ?? {
      rows: this.match(orExpression(effective.terms), retrieval),
      route: 'or' as const
    }
    return {
      hits: this.rollUp(result.rows, retrieval, effective),
      route: repaired ? (`typo+${result.route}` as AiVaultSearchRoute) : result.route,
      ...(repaired ? { repairedTerms: repaired.body } : {})
    }
  }

  /** Operator-only queries: newest sessions the constraints allow, no evidence. */
  private recent(retrieval: Retrieval): AiVaultSearchHit[] {
    const { conditions, values } = retrieval.filter
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sessions = this.db
      .prepare(
        `SELECT * FROM ${VISIBLE_SESSIONS} ${where} ORDER BY updated_at DESC LIMIT ${SESSION_CANDIDATE_LIMIT}`
      )
      .all(...values) as SessionRow[]
    // Why through the ranker: forks must fold here exactly as they do for a text
    // query, or the same sessions answer `repo:x` and `word repo:x` differently.
    // There is no relevance signal without text, so the order is always newest.
    const matches = new Map(
      sessions.map((session) => [
        session.id,
        { rowid: 0, score: 0, session_row_id: session.id, role: 'unknown', ts: null }
      ])
    )
    return rankSessionHits(sessions, matches, { ...retrieval.args, sort: 'newest' }, () => '')
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
  private retrieveLiteral(
    plan: SessionSearchQueryPlan,
    retrieval: Retrieval
  ): { rows: MessageRow[]; route: 'phrase' | 'and' } | null {
    if (!plan.literal || plan.body.length === 0) {
      return null
    }
    // A one-token literal (`resolveTerminalPath`, `src/a/b.ts`) is its own
    // phrase: the tokenizer keeps it whole, so the exact token is the cheap,
    // precise first try before the identifier pieces fan out over OR.
    const phrase = this.match(phraseExpression(plan.body), retrieval)
    if (phrase.length > 0) {
      return { rows: phrase, route: 'phrase' }
    }
    if (plan.body.length < 2) {
      return null
    }
    const and = this.match(andExpression(plan.body), retrieval)
    return and.length > 0 ? { rows: and, route: 'and' } : null
  }

  private match(expression: string, retrieval: Retrieval): MessageRow[] {
    const { tier, filter, args } = retrieval
    const eligible = filter.conditions.length
      ? ` AND m.session_row_id IN (SELECT id FROM ${VISIBLE_SESSIONS} WHERE ${filter.conditions.join(' AND ')})`
      : ''
    const table = tier === 'full' ? 'messages_fts' : 'conversation_fts'
    const weights = tier === 'full' ? FULL_WEIGHTS : CONVERSATION_WEIGHTS
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
    const order = args.sort === 'newest' ? 'updated_at DESC, score DESC' : 'score DESC'
    const sql = `WITH matched AS MATERIALIZED (${matched})
      SELECT rowid, max(score) AS score, session_row_id, role, ts FROM matched
      GROUP BY session_row_id ORDER BY ${order} LIMIT ${SESSION_CANDIDATE_LIMIT}`
    return this.db.prepare(sql).all(expression, ...filter.values) as MessageRow[]
  }

  private rollUp(
    rows: MessageRow[],
    retrieval: Retrieval,
    plan: SessionSearchQueryPlan
  ): AiVaultSearchHit[] {
    // `match` already grouped to one best row per session.
    const best = new Map(rows.map((row) => [row.session_row_id, row]))
    if (best.size === 0) {
      return []
    }
    const table = retrieval.tier === 'full' ? 'messages_fts' : 'conversation_fts'
    return rankSessionHits(
      this.loadSessions([...best.keys()], retrieval.filter),
      best,
      retrieval.args,
      (message) => this.snippet(table, message.rowid, plan)
    )
  }

  // Why: the snippet must highlight the terms that actually retrieved the row,
  // so a hit found through typo repair is marked with the repaired terms.
  private snippet(table: string, rowid: number, plan: SessionSearchQueryPlan): string {
    const expression = orExpression(plan.terms)
    // Why: the identifier shadow column is word soup; a hit that also matches
    // in a prose column should be shown from there. Column -1 (any column) is
    // the fallback for rows that only matched through the shadow column.
    const columns = table === 'messages_fts' ? [0, 1, 2, -1] : [0, 1, -1]
    const select = columns
      .map(
        (column, index) =>
          `snippet(${table}, ${column}, '${SNIPPET_MARK_OPEN}', '${SNIPPET_MARK_CLOSE}', '…', ${SNIPPET_TOKENS}) AS c${index}`
      )
      .join(', ')
    try {
      // Why: a bound `rowid = ?` or `rowid IN (?)` next to MATCH is silently
      // ignored by the FTS5 planner (it returns the first match); only the
      // subselect form is honoured.
      const row = this.db
        .prepare(`SELECT ${select} FROM ${table} WHERE ${table} MATCH ? AND rowid IN (SELECT ?)`)
        .get(expression, rowid) as Record<string, string> | undefined
      if (!row) {
        return ''
      }
      // A snippet with nothing highlighted tells the user nothing; omit it.
      return (
        columns.map((_, index) => row[`c${index}`]).find((s) => s.includes(SNIPPET_MARK_OPEN)) ?? ''
      )
    } catch {
      return ''
    }
  }

  private loadSessions(ids: number[], filter: SessionRowFilter): SessionRow[] {
    const conditions = [`id IN (${ids.map(() => '?').join(',')})`, ...filter.conditions]
    return this.db
      .prepare(`SELECT * FROM ${VISIBLE_SESSIONS} WHERE ${conditions.join(' AND ')}`)
      .all(...ids, ...filter.values) as SessionRow[]
  }
}
