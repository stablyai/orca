import type SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessageRole } from '../ai-vault/session-transcript-consumers'
import {
  hasAiVaultSearchQueryOperators,
  splitAiVaultSearchQuery,
  type AiVaultSearchQuerySplit
} from '../../shared/ai-vault-search-query-operators'
import { matchesAiVaultQueryOperators } from '../../shared/ai-vault-session-filters'
import {
  resolveSessionSearchLimit,
  SESSION_SEARCH_QUERY_MAX_LENGTH,
  type SessionSearchHit,
  type SessionSearchRequest,
  type SessionSearchResponse,
  type SessionSearchSourcePresence
} from './session-search-engine-types'
import type { SessionSearchUnavailableFeature } from './session-search-index-capabilities'
import {
  rankSessionHits,
  type MessageRow,
  type RankedSession,
  type SessionRow
} from './session-search-hit-ranking'
import {
  decodeSessionSearchCursor,
  encodeSessionSearchCursor,
  sessionSearchPageKey
} from './session-search-page-cursor'
import { planSessionSearchQuery } from './session-search-query-planner'
import { logSessionSearchQuery } from './session-search-query-log'
import {
  ftsTableFor,
  SessionSearchRetrieval,
  type RetrievalScope,
  type Retrieved
} from './session-search-retrieval'
import { sessionRowFilter } from './session-search-row-filter'
import { sessionSearchUnavailableFeatures } from './session-search-index-capabilities'
import { EMPTY_SNIPPET, sessionSearchSnippet } from './session-search-snippet'
import { sessionSourcePresence } from './session-search-source-presence'
import type { SessionSearchStore } from './session-search-store'

/**
 * Sessions retrieved before ranking cuts the page.
 *
 * Not a fixed constant (the reviewer's F13): it is the knob that trades page
 * completeness for retrieval cost, and the right value depends on index size.
 * Measurements behind this default, and what changing it costs, are in
 * docs/reference/agent-session-search-query-tuning.md.
 */
export const SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT = 600

/** One ranked list plus what produced it; a page is a slice of `ranked`. */
type RankedPage = {
  ranked: RankedSession[]
  /** Null when no text was searched, so there is nothing to snippet from. */
  retrieved: Retrieved | null
  /** Sessions the SQL returned, before fork folding cut it down. */
  candidates: number
}

export type SessionSearchEngineOptions = {
  sessionCandidateLimit?: number
  /** Oldest transcript mtime a hit may come from; PR 3 derives it from retention. */
  retentionCutoffMs?: number | null
  /** Write each query to `search_log`. Off unless a caller asks (see query-log). */
  logQueries?: boolean
}

/**
 * Ranked session search over the PR 2 index.
 *
 * A library: it holds no timers, reads no settings, and knows nothing about
 * Electron, IPC or a panel. It reads through the store's own connection, so a
 * query cannot pin a second WAL snapshot behind the writer.
 *
 * One search is one synchronous pass, and every page of it is a slice of the
 * same ranked list. That list is rebuilt per page rather than streamed, which
 * is what makes a page repeatable: within one index generation the same request
 * ranks the same way, and a cursor from any other generation is refused.
 */
export class SessionSearchEngine {
  private readonly db: SyncDatabase
  private readonly retrieval: SessionSearchRetrieval
  private readonly candidateLimit: number
  /** Probed once: a version-1 file has neither vocabulary nor query log. */
  private readonly unavailable: readonly SessionSearchUnavailableFeature[]

  constructor(
    private readonly store: SessionSearchStore,
    private readonly options: SessionSearchEngineOptions = {}
  ) {
    this.db = store.connection
    this.unavailable = sessionSearchUnavailableFeatures(this.db)
    this.retrieval = new SessionSearchRetrieval(this.db, !this.unavailable.includes('typo-repair'))
    this.candidateLimit = options.sessionCandidateLimit ?? SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT
  }

  search(request: SessionSearchRequest): SessionSearchResponse {
    const startedAt = performance.now()
    // Why here and nowhere else: warming is only worth its I/O once something
    // is about to read those pages. The store memoizes, so this is one warm-up
    // per store and a no-op on every later query.
    void this.store.warm()

    const generation = this.store.generation
    const scope = request.scope ?? 'all'
    const sort = request.filters?.sort ?? 'relevance'
    const split = splitAiVaultSearchQuery(request.query.slice(0, SESSION_SEARCH_QUERY_MAX_LENGTH))
    const retrievalScope: RetrievalScope = {
      scope,
      sort,
      filter: sessionRowFilter(request.filters ?? {}, this.options.retentionCutoffMs ?? null),
      matchesOperators: operatorPredicate(split),
      candidateLimit: this.candidateLimit
    }
    // Decoded before any retrieval: a cursor the engine will refuse must not
    // cost a query, and the caller has to hear about it either way.
    const pageKey = sessionSearchPageKey(request)
    const offset = request.cursor
      ? decodeSessionSearchCursor(request.cursor, generation, pageKey)
      : 0

    const plan = planSessionSearchQuery(split.text)
    const { ranked, retrieved, candidates } =
      plan.terms.length === 0
        ? this.operatorOnly(split, retrievalScope)
        : this.text(plan, retrievalScope, sort)

    const limit = resolveSessionSearchLimit(request.limit)
    const page = ranked.slice(offset, offset + limit)
    const hits = this.hits(page, ftsTableFor(scope), retrieved)
    const hasMore = ranked.length > offset + limit
    const response: SessionSearchResponse = {
      hits,
      unavailable: this.unavailable,
      planner: {
        route: retrieved?.route ?? 'or',
        tier: scope,
        ...(retrieved?.repairedTerms ? { repairedTerms: retrieved.repairedTerms } : {})
      },
      page: {
        hasMore,
        cursor: hasMore ? encodeSessionSearchCursor(generation, offset + limit, pageKey) : null
      },
      truncated: {
        // Counted before fork folding: the SQL LIMIT is what produced the cut,
        // and a full candidate set is exactly where a session may be missing.
        candidates: candidates >= this.candidateLimit,
        snippets: hits.filter((hit) => hit.evidence?.snippetTruncated).length
      },
      generation,
      durationMs: performance.now() - startedAt
    }
    if (this.options.logQueries && !this.unavailable.includes('query-log')) {
      logSessionSearchQuery(this.db, {
        query: request.query,
        route: response.planner.route,
        hits: hits.length,
        durationMs: response.durationMs
      })
    }
    return response
  }

  /**
   * Operators with no free text still name a scope, so the answer is the newest
   * sessions inside it. Ranked through the same path as a text query, because
   * forks must fold here exactly as they do there or the same sessions answer
   * `repo:x` and `word repo:x` differently. There is no relevance signal
   * without text, so the order is always newest.
   */
  private operatorOnly(split: AiVaultSearchQuerySplit, scope: RetrievalScope): RankedPage {
    if (!hasAiVaultSearchQueryOperators(split)) {
      return { ranked: [], retrieved: null, candidates: 0 }
    }
    const { sessions } = this.retrieval.recent(scope)
    return {
      ranked: rankSessionHits(sessions, new Map(), 'newest'),
      retrieved: null,
      candidates: sessions.length
    }
  }

  private text(
    plan: ReturnType<typeof planSessionSearchQuery>,
    scope: RetrievalScope,
    sort: 'relevance' | 'newest'
  ): RankedPage {
    const retrieved = this.retrieval.run(plan, scope)
    // `match` already grouped to one best row per session.
    const best = new Map<number, MessageRow>(retrieved.rows.map((row) => [row.session_row_id, row]))
    // Operators cut here, after retrieval, so the candidate count still reports
    // what the SQL limit saw: that is what tells a caller the limit was binding.
    const sessions = this.retrieval.loadSessions([...best.keys()], scope)
    return { ranked: rankSessionHits(sessions, best, sort), retrieved, candidates: best.size }
  }

  /** Snippets and source presence are paid for by the page, never by the list. */
  private hits(
    page: readonly RankedSession[],
    table: 'messages_fts' | 'conversation_fts',
    retrieved: Retrieved | null
  ): SessionSearchHit[] {
    const presence = sessionSourcePresence(
      this.db,
      page.map((entry) => entry.session.id)
    )
    return page.map((entry) => this.hit(entry, table, retrieved, presence))
  }

  private hit(
    entry: RankedSession,
    table: 'messages_fts' | 'conversation_fts',
    retrieved: Retrieved | null,
    presence: ReadonlyMap<number, SessionSearchSourcePresence>
  ): SessionSearchHit {
    const { session, message } = entry
    const snippet =
      message && retrieved
        ? sessionSearchSnippet(this.db, table, message.rowid, retrieved.plan)
        : EMPTY_SNIPPET
    return {
      ...sessionFields(session),
      score: entry.score,
      ...(entry.duplicateCount > 1 ? { duplicateCount: entry.duplicateCount } : {}),
      source: presence.get(session.id) ?? 'unverifiable',
      evidence: message
        ? {
            role: message.role as TranscriptMessageRole,
            timestamp: message.ts,
            snippet: snippet.text,
            ...(snippet.truncated ? { snippetTruncated: true } : {})
          }
        : null
    }
  }
}

/**
 * The one reading of `repo:` / `path:`: the sessions panel's own predicate, over
 * the columns the index stores. The engine has no project map, so a session's
 * repo label falls back to its folder label, which is what the panel does for
 * every session it cannot resolve a project for.
 */
function operatorPredicate(split: AiVaultSearchQuerySplit): (session: SessionRow) => boolean {
  if (!hasAiVaultSearchQueryOperators(split)) {
    return () => true
  }
  return (session) =>
    matchesAiVaultQueryOperators(
      { cwd: session.cwd, filePath: session.file_path },
      { repoTerms: split.repoTerms, pathTerms: split.pathTerms }
    )
}

function sessionFields(
  session: SessionRow
): Omit<SessionSearchHit, 'score' | 'evidence' | 'source' | 'duplicateCount'> {
  return {
    agent: session.agent,
    sessionId: session.session_id,
    filePath: session.file_path,
    codexHome: session.codex_home,
    title: session.title,
    cwd: session.cwd,
    branch: session.branch,
    updatedAt: session.updated_at,
    messageCount: session.message_count,
    resumeCommand: session.resume_command
  }
}
