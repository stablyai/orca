import type SyncDatabase from '../../sqlite/sync-database'
import type { SessionSearchRoute, SessionSearchScope } from './session-search-engine-types'
import type { SessionSearchFrozenHit } from './session-search-ranked-cursor'
import { SessionSearchCursorError } from './session-search-page-cursor'
import { readIndexGeneration } from '../storage/session-search-index-generation'
import type { RankedSession, MessageRow, SessionRow } from './session-search-hit-ranking'
import {
  andExpression,
  orExpression,
  phraseExpression,
  planSessionSearchQuery,
  scopedExpression,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import type { SessionRowFilter } from './session-search-row-filter'
import {
  SessionSearchTypoRepair,
  SessionSearchVocabularyBudget
} from './session-search-typo-repair'
import { SessionSearchPostings, SESSION_SEARCH_MESSAGE_CANDIDATES } from './session-search-postings'

const RECENT_PAGE_ROWS = 512
// Leave SQLite parameter capacity for filter values as well as session IDs.
const SESSION_ID_BATCH = 500
const RECENT_SCAN_FACTOR = 20

// BM25 column order: user, assistant, tool, identifiers.
const FULL_WEIGHTS = '3.0, 2.0, 1.0, 1.0'
const CONVERSATION_WEIGHTS = '3.0, 2.0, 0.0, 0.0'

// Keep SQL text stable for statement-cache reuse.
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

  /** Preserve original OR hits before spending the remaining allowance on optional repair. */
  run(plan: SessionSearchQueryPlan, scope: RetrievalScope): Retrieved {
    let incomplete = false
    const sessionCache = new Map<number, SessionRow | null>()
    const postings = new SessionSearchPostings(this.db, scope.scope, (id) => {
      if (!sessionCache.has(id)) {
        sessionCache.set(id, this.loadSessions([id], scope)[0] ?? null)
      }
      return sessionCache.get(id) !== null
    })
    const match = (expression: string): MessageRow[] => {
      const rows = this.match(expression, scope, postings)
      incomplete ||= rows.length >= SESSION_SEARCH_MESSAGE_CANDIDATES
      return rows
    }
    const sessionsFor = (rows: MessageRow[]): SessionRow[] =>
      [...new Set(rows.map((row) => row.session_row_id))].flatMap(
        (id) => sessionCache.get(id) ?? []
      )
    const exact = this.phraseThenAnd(plan, match)
    if (exact) {
      return {
        ...exact,
        plan,
        incomplete: incomplete || postings.exhausted,
        sessions: sessionsFor(exact.rows)
      }
    }
    const original = { rows: match(orExpression(plan.terms)), route: 'or' as const }
    const vocabulary = new SessionSearchVocabularyBudget()
    const repaired = this.repair(plan, scope.scope, postings, vocabulary)
    const attempted = repaired
      ? (this.phraseThenAnd(repaired, match) ?? {
          rows: match(orExpression(repaired.terms)),
          route: 'or' as const
        })
      : null
    const successfulRepair = attempted && attempted.rows.length > 0 ? repaired : null
    const found = successfulRepair && attempted ? attempted : original
    return {
      sessions: sessionsFor(found.rows),
      rows: found.rows,
      incomplete: incomplete || postings.exhausted || vocabulary.exhausted,
      route: successfulRepair ? `typo+${found.route}` : found.route,
      plan: successfulRepair ?? plan,
      ...(successfulRepair ? { repairedTerms: successfulRepair.body } : {})
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

  /** Hydrate only the frozen slice; reapply scope and message ownership to untrusted cursor IDs. */
  hydrate(hits: readonly SessionSearchFrozenHit[], scope: RetrievalScope): RankedSession[] {
    const sessions = new Map(
      this.loadSessions(
        hits.map((hit) => hit.s),
        scope
      ).map((row) => [row.id, row])
    )
    const ids = hits.flatMap((hit) => (hit.m === null ? [] : [hit.m]))
    const messages = new Map<number, MessageRow>()
    if (ids.length) {
      const rows = this.db
        .prepare(`SELECT id AS rowid, session_row_id, role, ts FROM messages
        WHERE id IN (${ids.map(() => '?').join(',')}) AND role != 'tool'`)
        .all(...ids)
      for (const row of rows) {
        messages.set(Number(row.rowid), {
          rowid: Number(row.rowid),
          session_row_id: Number(row.session_row_id),
          role: String(row.role),
          ts: typeof row.ts === 'string' ? row.ts : null,
          score: 0
        })
      }
    }
    return hits.map((hit) => {
      const session = sessions.get(hit.s)
      const message = hit.m === null ? null : messages.get(hit.m)
      if (!session || message === undefined || (message && message.session_row_id !== hit.s)) {
        throw new SessionSearchCursorError('malformed', readIndexGeneration(this.db))
      }
      return { session, message, score: hit.score, duplicateCount: hit.d }
    })
  }

  /** Bound SQL parameters independently of the configurable candidate limit. */
  private loadSessions(ids: readonly number[], scope: RetrievalScope): SessionRow[] {
    const rows: SessionRow[] = []
    const { conditions: predicates, values } = scope.filter.candidate
    for (let start = 0; start < ids.length; start += SESSION_ID_BATCH) {
      const batch = ids.slice(start, start + SESSION_ID_BATCH)
      const conditions = [`id IN (${batch.map(() => '?').join(',')})`, ...predicates]
      const sessionRows = this.db
        .prepare(`SELECT ${SESSION_COLUMN_LIST} FROM sessions WHERE ${conditions.join(' AND ')}`)
        .all(...batch, ...values)
        .filter((row) =>
          scope.filter.matchesScope(typeof row.cwd_key === 'string' ? row.cwd_key : null)
        )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The selected columns match the private sessions schema defining SessionRow.
      rows.push(...(sessionRows as SessionRow[]))
    }
    return rows.filter((row) => scope.matchesOperators(row))
  }

  private repair(
    plan: SessionSearchQueryPlan,
    scope: SessionSearchScope,
    postings: SessionSearchPostings,
    vocabulary: SessionSearchVocabularyBudget
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
      const fix = typoRepair.correct(token, scope, postings, vocabulary)
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

  private match(
    expression: string,
    scope: RetrievalScope,
    postings: SessionSearchPostings
  ): MessageRow[] {
    const rows: MessageRow[] = []
    for (const row of postings.matching(expression)) {
      rows.push(row)
      if (rows.length >= SESSION_SEARCH_MESSAGE_CANDIDATES) {
        break
      }
    }
    if (!rows.length) {
      return []
    }
    const admitted = new Map(rows.map((row) => [row.rowid, row]))
    const ids = [...admitted.keys()]
    // Why: one range cursor retains BM25's corpus statistics across all admitted rows.
    const scores = this.db
      .prepare(`SELECT rowid, -bm25(messages_fts, ${scopedWeights(scope.scope)}) AS score
        FROM messages_fts WHERE messages_fts MATCH ?
        AND rowid >= CAST(? AS INTEGER) AND rowid <= CAST(? AS INTEGER)`)
      .iterate(scopedExpression(scope.scope, expression), Math.min(...ids), Math.max(...ids))
    for (const score of scores) {
      const row = admitted.get(Number(score.rowid))
      if (row) {
        row.score = Number(score.score)
      }
    }
    return rows
  }
}
