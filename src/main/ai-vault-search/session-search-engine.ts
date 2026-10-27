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
import { readIndexGeneration, readIndexIncarnation } from './session-search-index-generation'
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
import { sessionSearchProjectOwns } from './session-search-project-ownership'
import type { SessionSearchProjectOwnership } from './session-search-project-ownership'
import { sessionSourcePresence } from './session-search-source-presence'

/** Candidate-limit tuning and measurements: docs/reference/agent-session-search-query-tuning.md. */
export const SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT = 600

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

/** Use independent statements to avoid pinning WAL; reject pages whose content generation changes. */
export class SessionSearchEngine {
  private readonly retrieval: SessionSearchRetrieval
  private readonly candidateLimit: number
  private ownership?: SessionSearchProjectOwnership

  constructor(
    private readonly db: SyncDatabase,
    private readonly options: SessionSearchEngineOptions = {}
  ) {
    this.db.function('canonical_project_owns', { deterministic: true }, (cwd, filePath) =>
      Number(
        Boolean(
          this.ownership &&
          typeof cwd === 'string' &&
          typeof filePath === 'string' &&
          sessionSearchProjectOwns(this.ownership, cwd, filePath)
        )
      )
    )
    this.candidateLimit = options.sessionCandidateLimit ?? SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT
    // Install tables and generation triggers before preparing retrieval or accepting writes.
    ensureSessionSearchQuerySchema(this.db)
    this.retrieval = new SessionSearchRetrieval(this.db)
  }

  generation(): number {
    return readIndexGeneration(this.db)
  }

  search(request: SessionSearchRequest): SessionSearchResponse {
    this.ownership = request.filters?.ownership
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
    const offset = request.cursor
      ? decodeSessionSearchCursor(
          request.cursor,
          generation,
          pageKey,
          incarnation,
          this.ownership?.fingerprint
        )
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
        cursor: hasMore
          ? encodeSessionSearchCursor(
              generation,
              offset + limit,
              pageKey,
              incarnation,
              this.ownership?.fingerprint
            )
          : null
      },
      truncated: {
        // Retrieval alone can distinguish an exhausted scan budget from no matching rows.
        candidates: incomplete,
        snippets: hits.filter((hit) => hit.evidence?.snippetTruncated).length,
        query: capped.length < request.query.length || plan.truncated
      },
      generation,
      durationMs: performance.now() - startedAt
    }
    return response
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
    const best = new Map<number, MessageRow>(retrieved.rows.map((row) => [row.session_row_id, row]))
    return {
      ranked: rankSessionHits(retrieved.sessions, best, sort),
      retrieved,
      incomplete: retrieved.incomplete
    }
  }

  /** Fetch snippets and presence only for the requested page. */
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
