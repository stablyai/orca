import type SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessageRole } from '../ai-vault/session-transcript-consumers'
import { sliceAtCodeUnitLimit } from '../ai-vault/session-scanner-text-normalization'
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
  type SessionSearchScope,
  type SessionSearchSourcePresence
} from './session-search-engine-types'
import { readIndexGeneration } from './session-search-index-generation'
import {
  rankSessionHits,
  type MessageRow,
  type RankedSession,
  type SessionRow
} from './session-search-hit-ranking'
import {
  SessionSearchCursorError,
  decodeSessionSearchCursor,
  encodeSessionSearchCursor,
  sessionSearchPageKey
} from './session-search-page-cursor'
import { planSessionSearchQuery } from './session-search-query-planner'
import {
  SessionSearchRetrieval,
  type RetrievalScope,
  type Retrieved
} from './session-search-retrieval'
import { sessionRowFilter } from './session-search-row-filter'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import { EMPTY_SNIPPET, sessionSearchSnippet } from './session-search-snippet'
import { sessionSourcePresence } from './session-search-source-presence'

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
  /**
   * Retrieval may have missed a session: a cap ended it, not the data. True
   * whether the candidate limit filled or the operator walk gave up scanning.
   */
  incomplete: boolean
}

export type SessionSearchEngineOptions = {
  sessionCandidateLimit?: number
  /** Oldest transcript mtime a hit may come from; PR 3 derives it from retention. */
  retentionCutoffMs?: number | null
}

/**
 * Synchronous searches use independent statements to avoid pinning the WAL.
 * Generation checks bracket all content reads; concurrent writes reject the page.
 * The connection's owner handles index rebuilds and engine reconstruction.
 */
export class SessionSearchEngine {
  private readonly retrieval: SessionSearchRetrieval
  private readonly candidateLimit: number

  constructor(
    private readonly db: SyncDatabase,
    private readonly options: SessionSearchEngineOptions = {}
  ) {
    this.candidateLimit = options.sessionCandidateLimit ?? SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT
    // Installed here and not on the first search, so the generation triggers are
    // watching before anything this engine will be asked to page over is
    // written, and so retrieval below prepares against tables that exist.
    ensureSessionSearchQuerySchema(this.db)
    this.retrieval = new SessionSearchRetrieval(this.db)
  }

  generation(): number {
    return readIndexGeneration(this.db)
  }

  search(request: SessionSearchRequest): SessionSearchResponse {
    const startedAt = performance.now()
    ensureSessionSearchQuerySchema(this.db)
    const generation = readIndexGeneration(this.db)
    const scope = request.scope ?? 'all'
    const sort = request.filters?.sort ?? 'relevance'
    // Not a bare `slice`: cutting between a surrogate pair leaves a lone half
    // that no tokenizer can match and that a caller cannot echo back.
    const capped = sliceAtCodeUnitLimit(request.query, SESSION_SEARCH_QUERY_MAX_LENGTH)
    const split = splitAiVaultSearchQuery(capped)
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
    const { ranked, retrieved, incomplete } =
      plan.terms.length === 0
        ? this.operatorOnly(split, retrievalScope)
        : this.text(plan, retrievalScope, sort)

    const limit = resolveSessionSearchLimit(request.limit)
    const page = ranked.slice(offset, offset + limit)
    const hits = this.hits(page, scope, retrieved)
    const actualGeneration = readIndexGeneration(this.db)
    if (actualGeneration !== generation) {
      throw new SessionSearchCursorError('stale-generation', actualGeneration, generation)
    }
    const hasMore = ranked.length > offset + limit
    const response: SessionSearchResponse = {
      hits,
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
        // Decided by retrieval, which is the only layer that knows whether a cap
        // ended it. Deriving it from the hits cannot work: an operator walk that
        // gave up at its scan ceiling returns no hits, and so does a search that
        // genuinely matched nothing.
        candidates: incomplete,
        snippets: hits.filter((hit) => hit.evidence?.snippetTruncated).length,
        query: capped.length < request.query.length || plan.truncated
      },
      generation,
      durationMs: performance.now() - startedAt
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
      return { ranked: [], retrieved: null, incomplete: false }
    }
    const { sessions, incomplete } = this.retrieval.recent(scope)
    return { ranked: rankSessionHits(sessions, new Map(), 'newest'), retrieved: null, incomplete }
  }

  private text(
    plan: ReturnType<typeof planSessionSearchQuery>,
    scope: RetrievalScope,
    sort: 'relevance' | 'newest'
  ): RankedPage {
    const retrieved = this.retrieval.run(plan, scope)
    // `match` already grouped to one best row per session.
    const best = new Map<number, MessageRow>(retrieved.rows.map((row) => [row.session_row_id, row]))
    return {
      ranked: rankSessionHits(retrieved.sessions, best, sort),
      retrieved,
      incomplete: retrieved.incomplete
    }
  }

  /** Snippets and source presence are paid for by the page, never by the list. */
  private hits(
    page: readonly RankedSession[],
    scope: SessionSearchScope,
    retrieved: Retrieved | null
  ): SessionSearchHit[] {
    const presence = sessionSourcePresence(
      this.db,
      page.map((entry) => entry.session.id)
    )
    return page.map((entry) => this.hit(entry, scope, retrieved, presence))
  }

  private hit(
    entry: RankedSession,
    scope: SessionSearchScope,
    retrieved: Retrieved | null,
    presence: ReadonlyMap<number, SessionSearchSourcePresence>
  ): SessionSearchHit {
    const { session, message } = entry
    const snippet =
      message && retrieved
        ? sessionSearchSnippet(this.db, scope, message.rowid, retrieved.plan)
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
