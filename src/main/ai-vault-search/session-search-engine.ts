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
  decodeSessionSearchCursor,
  encodeSessionSearchCursor,
  sessionSearchPageKey
} from './session-search-page-cursor'
import { planSessionSearchQuery } from './session-search-query-planner'
import { logSessionSearchQuery } from './session-search-query-log'
import {
  SessionSearchRetrieval,
  type RetrievalScope,
  type Retrieved
} from './session-search-retrieval'
import { sessionRowFilter } from './session-search-row-filter'
import {
  ensureSessionSearchQuerySchema,
  type SessionSearchUnavailableFeature
} from './session-search-query-schema'
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
  /** Write each query to `search_log`. Off unless a caller asks (see query-log). */
  logQueries?: boolean
}

/**
 * Ranked session search over the PR 2 index.
 *
 * A library: it holds no timers, reads no settings, and knows nothing about
 * Electron, IPC or a panel. It is handed a connection rather than opening one,
 * because which process may open, rebuild or unlink the index file is PR 3b's
 * decision and not a query engine's.
 *
 * **Every read here is a single statement, and no read transaction is ever
 * open across an `await`.** There is no `BEGIN` on this path, no `.iterate()`
 * outliving its statement, and `search` is synchronous end to end. That is a
 * constraint PR 2 measured rather than a style: a reader that pins a WAL
 * snapshot holds off every checkpoint behind it, and the same 47 MB of writes
 * that leave a 9.9 MB WAL grew to 266 MB with one `BEGIN` + `SELECT` held open.
 *
 * One search is one synchronous pass, and every page of it is a slice of the
 * same ranked list. That list is rebuilt per page rather than streamed, which
 * is what makes a page repeatable: within one index generation the same request
 * ranks the same way, and a cursor from any other generation is refused.
 *
 * That fence is strict on purpose, and the cost is worth stating plainly: any
 * committed read moves the generation, so while a backfill is running an
 * outstanding cursor will be refused, often within a second. Pagination is
 * usable against a settled index and unreliable against one still filling. The
 * rejection carries both generations, so a caller that sees `stale-generation`
 * knows the index moved rather than that it holds a bad cursor, and can quietly
 * re-issue page one instead of showing anyone an error.
 */
export class SessionSearchEngine {
  private retrieval: SessionSearchRetrieval
  private readonly candidateLimit: number
  /** Re-probed whenever a query proves it stale; see `withCapabilityRetry`. */
  private unavailable: readonly SessionSearchUnavailableFeature[]

  constructor(
    private readonly db: SyncDatabase,
    private readonly options: SessionSearchEngineOptions = {}
  ) {
    this.candidateLimit = options.sessionCandidateLimit ?? SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT
    // Installed here and not on the first search, so the generation triggers are
    // watching before anything this engine will be asked to page over is
    // written, and so retrieval below prepares against tables that exist.
    this.unavailable = ensureSessionSearchQuerySchema(this.db)
    this.retrieval = new SessionSearchRetrieval(this.db, !this.unavailable.includes('typo-repair'))
  }

  search(request: SessionSearchRequest): SessionSearchResponse {
    const startedAt = performance.now()
    this.probeCapabilities()
    const generation = readIndexGeneration(this.db)
    const scope = request.scope ?? 'all'
    const sort = request.filters?.sort ?? 'relevance'
    const capped = request.query.slice(0, SESSION_SEARCH_QUERY_MAX_LENGTH)
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
    const { ranked, retrieved, incomplete } = this.withCapabilityRetry(() =>
      plan.terms.length === 0
        ? this.operatorOnly(split, retrievalScope)
        : this.text(plan, retrievalScope, sort)
    )

    const limit = resolveSessionSearchLimit(request.limit)
    const page = ranked.slice(offset, offset + limit)
    const hits = this.hits(page, scope, retrieved)
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
    if (this.options.logQueries) {
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
   * Where the engine's own schema is created and checked, once per search.
   *
   * A capability is a fact about the file, not about this object: another handle
   * can rebuild the index under a live connection, so a verdict cached in the
   * constructor is wrong for the rest of the engine's life in both directions —
   * it would keep reaching for a table that went away, and never pick one back
   * up when it returned. Retrieval is only rebuilt when the answer changes, so
   * the steady-state cost is one indexed lookup and nothing else.
   */
  private probeCapabilities(): void {
    const unavailable = ensureSessionSearchQuerySchema(this.db)
    if (unavailable.join() === this.unavailable.join()) {
      return
    }
    this.unavailable = unavailable
    this.retrieval = new SessionSearchRetrieval(this.db, !unavailable.includes('typo-repair'))
  }

  /**
   * Runs a retrieval, and re-probes once if it turns out the index no longer
   * has what an earlier probe found.
   *
   * `probeCapabilities` already runs per search, so this only covers the window
   * between that probe and the statement that reaches for the table. Losing a
   * table there is a thrown error rather than a wrong verdict, so it re-probes
   * and runs the search again.
   */
  private withCapabilityRetry(run: () => RankedPage): RankedPage {
    try {
      return run()
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw error
      }
      this.probeCapabilities()
      return run()
    }
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
    // Operators cut here, after retrieval, so the candidate count still reports
    // what the SQL limit saw: that is what tells a caller the limit was binding.
    const sessions = this.retrieval.loadSessions([...best.keys()], scope)
    // Counted before the operator predicate and before fork folding: the SQL
    // LIMIT is what could have hidden a session, and it saw the unfiltered set.
    return {
      ranked: rankSessionHits(sessions, best, sort),
      retrieved,
      incomplete: best.size >= this.candidateLimit
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

// SQLite reports a table that went away at the statement that reaches for it.
// `fts5` is in the message when the table is the vocabulary's target, which is
// the one an index rebuilt under a live connection loses first.
const MISSING_TABLE = /no such (fts5 )?table/i

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && MISSING_TABLE.test(error.message)
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
