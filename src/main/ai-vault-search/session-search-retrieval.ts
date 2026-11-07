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

const RECENT_PAGE_ROWS = 512
// Leave SQLite parameter capacity for filter values as well as session IDs.
const SESSION_ID_BATCH = 500
const RECENT_SCAN_FACTOR = 20

// BM25 column order: user, assistant, tool, identifiers.
const FULL_WEIGHTS = '3.0, 2.0, 1.0, 1.0'
const CONVERSATION_WEIGHTS = '3.0, 2.0, 0.0, 0.0'

// Keep SQL text stable for statement-cache reuse; tests pin the projected schema.
const SESSION_COLUMN_LIST = (
  [
    'id',
    'agent',
    'session_id',
    'file_path',
    'codex_home',
    'title',
    'cwd',
    'cwd_key',
    'branch',
    'created_at',
    'updated_at',
    'message_count',
    'resume_command',
    'content_hash',
    'content_hash_count'
  ] as const satisfies readonly (keyof SessionRow | 'cwd_key' | 'created_at')[]
).join(', ')

export type RetrievalScope = {
  scope: SessionSearchScope
  sort: 'relevance' | 'newest'
  filter: SessionRowFilter
  /** Apply the sidebar’s repo:/path: predicates after SQL filtering to preserve query semantics. */
  matchesOperators: (session: SessionRow) => boolean
  /** Session candidates before final ranking and pagination. */
  candidateLimit: number
}

export type Retrieved = {
  sessions: SessionRow[]
  rows: MessageRow[]
  incomplete: boolean
  route: SessionSearchRoute
  /** Effective retrieval plan, including repairs, used to highlight snippets. */
  plan: SessionSearchQueryPlan
  repairedTerms?: string[]
}

export function scopedWeights(scope: SessionSearchScope): string {
  return scope === 'all' ? FULL_WEIGHTS : CONVERSATION_WEIGHTS
}

export class SessionSearchRetrieval {
  private readonly typoRepair: SessionSearchTypoRepair

  constructor(private readonly db: SyncDatabase) {
    this.typoRepair = new SessionSearchTypoRepair(db)
  }

  /** Try typo repair before OR so common words cannot mask a misspelled term. */
  run(plan: SessionSearchQueryPlan, scope: RetrievalScope): Retrieved {
    let incomplete = false
    let sessions: SessionRow[] = []
    const match = (expression: string): MessageRow[] => {
      const rows = this.match(expression, scope)
      // Only the route returned to the caller determines whether candidates were truncated.
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

  /** Page until enough JS-filtered operator matches are found, or the scan ceiling is reached. */
  recent(scope: RetrievalScope): { sessions: SessionRow[]; incomplete: boolean } {
    const { conditions, values } = scope.filter
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const page = this.db.prepare(
      `SELECT ${SESSION_COLUMN_LIST} FROM sessions ${where}
       ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    const ceiling = scope.candidateLimit * RECENT_SCAN_FACTOR
    const sessions: SessionRow[] = []
    let scanned = 0
    // Reaching the scan ceiling is incomplete even when no operator matches were found.
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
      const sessionRows = this.db
        .prepare(`SELECT ${SESSION_COLUMN_LIST} FROM sessions WHERE ${conditions.join(' AND ')}`)
        .all(...batch, ...scope.filter.values)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The private sessions schema defines SessionRow; tests compare every projected column and value with that schema.
      rows.push(...(sessionRows as SessionRow[]))
    }
    return rows.filter((row) => scope.matchesOperators(row))
  }

  private repair(
    plan: SessionSearchQueryPlan,
    scope: SessionSearchScope
  ): SessionSearchQueryPlan | null {
    const typoRepair = this.typoRepair
    let changed = false
    // Repair body terms but replan the full phrase so indexed stop words remain adjacent.
    const repairable = new Set(plan.body.map((term) => term.toLowerCase()))
    const phrase = plan.phrase.map((token) => {
      if (!repairable.has(token.toLowerCase())) {
        return token
      }
      // Tool-only vocabulary must neither suppress nor supply a conversation-scoped repair.
      const fix = typoRepair.correct(token, scope)
      if (fix && fix !== token.toLowerCase()) {
        changed = true
        return fix
      }
      return token
    })
    // Preserve literal mode after repair so corrected terms cannot turn into discarded stop words.
    return changed ? planSessionSearchQuery(phrase.join(' '), plan.literal) : null
  }

  /** Try phrase/AND for prose too, before common OR terms can crowd out an exact sentence. */
  private phraseThenAnd(
    plan: SessionSearchQueryPlan,
    match: (expression: string) => MessageRow[]
  ): { rows: MessageRow[]; route: 'phrase' | 'and' } | null {
    const tokens = plan.phrase
    // Single-token literals get an exact attempt before identifier expansion; single prose words go to OR.
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
    // Group before limiting so one long session cannot consume the candidate budget.
    // SQLite’s max(score) selects the best matching row for the other projected columns.
    const order = sort === 'newest' ? 'updated_at DESC, score DESC' : 'score DESC'
    const sql = `WITH matched AS MATERIALIZED (${matched})
      SELECT rowid, max(score) AS score, session_row_id, role, ts FROM matched
      GROUP BY session_row_id ORDER BY ${order} LIMIT ${candidateLimit}`
    return this.db
      .prepare(sql)
      .all(scopedExpression(scope.scope, expression), ...filter.values) as MessageRow[]
  }
}
