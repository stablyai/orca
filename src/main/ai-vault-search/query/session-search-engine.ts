import type SyncDatabase from '../../sqlite/sync-database'
import type { TranscriptMessageRole } from '../../ai-vault/transcripts/session-transcript-consumers'
import '../../ai-vault/parsing/session-scanner-text-normalization'
import { sliceAtCodeUnitLimit } from '../../../shared/surrogate-safe-text-slice'
import {
  hasAiVaultSearchQueryOperators,
  splitAiVaultSearchQuery,
  type AiVaultSearchQuerySplit
} from '../../../shared/ai-vault/search/ai-vault-search-query-operators'
import { matchesAiVaultQueryOperators } from '../../../shared/ai-vault/session-display/ai-vault-session-filters'
import {
  SESSION_SEARCH_QUERY_MAX_LENGTH,
  type SessionSearchHit,
  type SessionSearchRequest,
  type SessionSearchResponse,
  type SessionSearchScope,
  type SessionSearchSourcePresence
} from './session-search-engine-types'
import { resolveSessionSearchLimit } from '../../../shared/ai-vault/search/ai-vault-search-limit'
import {
  readIndexContentRevision,
  readIndexGeneration,
  readIndexIncarnation
} from '../storage/session-search-index-generation'
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
import {
  SESSION_SEARCH_MAX_CANDIDATES,
  decodeRankedSessionSearchCursor,
  encodeRankedSessionSearchCursor,
  type SessionSearchRankedCursor
} from './session-search-ranked-cursor'
import { planSessionSearchQuery } from './session-search-query-planner'
import {
  SessionSearchRetrieval,
  type RetrievalScope,
  type Retrieved
} from './session-search-retrieval'
import { sessionRowFilter } from './session-search-row-filter'
import { ensureSessionSearchQuerySchema } from '../storage/session-search-query-schema'
import { EMPTY_SNIPPET, sessionSearchSnippet } from './session-search-snippet'
import { sessionSourcePresence } from './session-search-source-presence'

/** Candidate-limit tuning and measurements: docs/reference/agent-session-search-query-tuning.md. */
export const SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT = 600

type SnippetPlan = Pick<Retrieved, 'plan' | 'route' | 'repairedTerms'>

type RankedPage = {
  ranked: RankedSession[]
  retrieved: Retrieved | null
  /** Retrieval stopped at a candidate or operator-scan limit. */
  incomplete: boolean
}

export type SessionSearchEngineOptions = {
  sessionCandidateLimit?: number
  /** Oldest eligible transcript mtime, derived from retention. */
  retentionCutoffMs?: number | null
}

/** One page reads one WAL snapshot; later page requests still validate their generation. */
export class SessionSearchEngine {
  private readonly retrieval: SessionSearchRetrieval
  private readonly candidateLimit: number

  constructor(
    private readonly db: SyncDatabase,
    private readonly options: SessionSearchEngineOptions = {}
  ) {
    this.candidateLimit = Math.min(
      SESSION_SEARCH_MAX_CANDIDATES,
      options.sessionCandidateLimit ?? SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT
    )
    // Install tables and generation triggers before preparing retrieval or accepting writes.
    ensureSessionSearchQuerySchema(this.db)
    this.retrieval = new SessionSearchRetrieval(this.db)
  }

  generation(): number {
    return readIndexGeneration(this.db)
  }

  search(request: SessionSearchRequest): SessionSearchResponse {
    this.db.exec('BEGIN')
    try {
      const result = this.readPage(request)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private readPage(request: SessionSearchRequest): SessionSearchResponse {
    const startedAt = performance.now()
    ensureSessionSearchQuerySchema(this.db)
    const generation = readIndexGeneration(this.db)
    const incarnation = readIndexIncarnation(this.db)
    const scope = request.scope ?? 'all'
    const sort = request.filters?.sort ?? 'relevance'
    const capped = sliceAtCodeUnitLimit(request.query, SESSION_SEARCH_QUERY_MAX_LENGTH)
    const split = splitAiVaultSearchQuery(capped)
    const retrievalScope: RetrievalScope = {
      scope,
      sort,
      filter: sessionRowFilter(request.filters ?? {}, this.options.retentionCutoffMs ?? null),
      matchesOperators: operatorPredicate(split),
      candidateLimit: this.candidateLimit
    }
    // Reject invalid cursors before paying for retrieval.
    const pageKey = sessionSearchPageKey(request)
    const frozen = request.cursor
      ? decodeRankedSessionSearchCursor(
          request.cursor,
          generation,
          readIndexContentRevision(this.db, generation),
          pageKey,
          incarnation
        )
      : null
    if (frozen) {
      const limit = resolveSessionSearchLimit(request.limit)
      const page = this.retrieval.hydrate(
        frozen.hits.slice(frozen.o, frozen.o + limit),
        retrievalScope
      )
      return this.frozenPage(frozen, page, scope, limit, startedAt)
    }
    const offset = request.cursor
      ? decodeSessionSearchCursor(request.cursor, generation, pageKey, incarnation)
      : 0

    const plan = planSessionSearchQuery(split.text)
    const { ranked, retrieved, incomplete } =
      plan.terms.length === 0
        ? this.operatorOnly(split, retrievalScope)
        : this.text(plan, retrievalScope, sort)

    const limit = resolveSessionSearchLimit(request.limit)
    const snapshot: SessionSearchRankedCursor = {
      v: 2,
      i: incarnation,
      g: generation,
      r: readIndexContentRevision(this.db, generation),
      k: pageKey,
      o: offset,
      hits: ranked.map((entry) => ({
        s: entry.session.id,
        m: entry.message?.rowid ?? null,
        score: entry.score,
        d: entry.duplicateCount
      })),
      retrieval: retrieved
        ? {
            plan: retrieved.plan,
            route: retrieved.route,
            ...(retrieved.repairedTerms ? { repairedTerms: retrieved.repairedTerms } : {})
          }
        : null,
      incomplete,
      queryTruncated: capped.length < request.query.length || plan.truncated
    }
    return this.frozenPage(
      snapshot,
      ranked.slice(offset, offset + limit),
      scope,
      limit,
      startedAt,
      !!request.cursor
    )
  }

  private frozenPage(
    frozen: SessionSearchRankedCursor,
    page: RankedSession[],
    scope: SessionSearchScope,
    limit: number,
    startedAt: number,
    legacy = false
  ): SessionSearchResponse {
    const hits = this.hits(page, scope, frozen.retrieval)
    const next = frozen.o + limit
    const hasMore = next < frozen.hits.length
    return {
      hits,
      planner: {
        route: frozen.retrieval?.route ?? 'or',
        tier: scope,
        ...(frozen.retrieval?.repairedTerms
          ? { repairedTerms: frozen.retrieval.repairedTerms }
          : {})
      },
      page: {
        hasMore,
        cursor: hasMore
          ? legacy
            ? encodeSessionSearchCursor(frozen.g, next, frozen.k, frozen.i)
            : encodeRankedSessionSearchCursor({ ...frozen, o: next })
          : null
      },
      truncated: {
        candidates: frozen.incomplete,
        query: frozen.queryTruncated,
        snippets: hits.filter((hit) => hit.evidence?.snippetTruncated).length
      },
      generation: frozen.g,
      durationMs: performance.now() - startedAt
    }
  }

  /** Operator-only queries use newest order and the same fork folding as text queries. */
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
    const best = new Map<number, MessageRow>()
    for (const row of retrieved.rows) {
      const previous = best.get(row.session_row_id)
      if (
        !previous ||
        row.score > previous.score ||
        (row.score === previous.score && row.rowid < previous.rowid)
      ) {
        best.set(row.session_row_id, row)
      }
    }
    const ranked = rankSessionHits(retrieved.sessions, best, sort)
    return {
      ranked: ranked.slice(0, this.candidateLimit),
      retrieved,
      incomplete: retrieved.incomplete || ranked.length >= this.candidateLimit
    }
  }

  /** Fetch snippets and presence only for the requested page. */
  private hits(
    page: readonly RankedSession[],
    scope: SessionSearchScope,
    retrieved: SnippetPlan | null
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
    retrieved: SnippetPlan | null,
    presence: ReadonlyMap<number, SessionSearchSourcePresence>
  ): SessionSearchHit {
    const { session, message } = entry
    const snippet =
      message && retrieved
        ? sessionSearchSnippet(this.db, scope, message.rowid, retrieved.plan, retrieved.route)
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

/** Reuse panel operator matching; repo labels fall back to folder labels without a project map. */
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
