import type SyncDatabase from '../sqlite/sync-database'
import type {
  AiVaultSearchArgs,
  AiVaultSearchCoverage,
  AiVaultSearchProviderCoverage,
  AiVaultSearchResult
} from '../../shared/ai-vault-search-types'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type {
  SessionSearchFileIdentity,
  SessionSearchIndexedFile,
  SessionSearchIndexSink,
  SessionSearchIndexUpdate
} from '../ai-vault/session-search-capture'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { SessionSearchIndexWriter } from './session-search-index-writer'
import { SessionSearchQuery } from './session-search-query'
import { openSessionSearchDatabase } from './session-search-schema'

// Why: the query log keeps only the surface form so the eval set can be rebuilt
// from real usage (the shoot-out's highest-value follow-up); bounded ring.
const SEARCH_LOG_LIMIT = 5000

export type SessionSearchBackfillState = 'idle' | 'running' | 'complete'

/** Owns the index database: the scanner writes through it, search reads from it. */
export class SessionSearchStore implements SessionSearchIndexSink {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private readonly query: SessionSearchQuery
  private backfill: SessionSearchBackfillState = 'idle'
  private lastIndexedAt: string | null = null
  private applyFailures = 0
  private readonly stale = new Map<string, SessionFileCandidate>()

  constructor(
    path: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.warn('[ai-vault-search] index write failed:', error)
  ) {
    this.db = openSessionSearchDatabase(path)
    this.writer = new SessionSearchIndexWriter(this.db)
    this.query = new SessionSearchQuery(this.db)
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    try {
      return this.writer.indexedFile(path, identity)
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  apply(update: SessionSearchIndexUpdate): void {
    try {
      this.writer.apply(update)
      this.lastIndexedAt = new Date().toISOString()
    } catch (error) {
      this.applyFailures += 1
      this.onError(error)
    }
  }

  markStale(candidate: SessionFileCandidate): void {
    this.stale.set(candidate.file.path, candidate)
  }

  /** Hands the stale set to the backfill lane and clears it. */
  takeStale(): SessionFileCandidate[] {
    const candidates = [...this.stale.values()]
    this.stale.clear()
    return candidates
  }

  get staleCount(): number {
    return this.stale.size
  }

  removeFile(path: string): void {
    try {
      this.writer.removeFile(path)
    } catch (error) {
      this.onError(error)
    }
  }

  setBackfillState(state: SessionSearchBackfillState): void {
    this.backfill = state
  }

  search(args: AiVaultSearchArgs): AiVaultSearchResult {
    const startedAt = performance.now()
    const execution = this.query.execute(args)
    const durationMs = performance.now() - startedAt
    this.logQuery(args.query, execution.route, execution.hits.length, durationMs)
    return {
      hits: execution.hits,
      route: execution.route,
      ...(execution.repairedTerms ? { repairedTerms: execution.repairedTerms } : {}),
      durationMs,
      coverage: this.coverage()
    }
  }

  coverage(): AiVaultSearchCoverage {
    const providers = this.db
      .prepare(
        `SELECT s.agent AS agent, COUNT(DISTINCT s.id) AS sessions, COUNT(m.id) AS messages
         FROM sessions s LEFT JOIN messages m ON m.session_row_id = s.id
         GROUP BY s.agent ORDER BY s.agent`
      )
      .all() as { agent: AiVaultAgent; sessions: number; messages: number }[]
    const byProvider: AiVaultSearchProviderCoverage[] = providers.map((row) => ({
      agent: row.agent,
      sessionsIndexed: row.sessions,
      messagesIndexed: row.messages
    }))
    return {
      sessionsIndexed: byProvider.reduce((sum, row) => sum + row.sessionsIndexed, 0),
      messagesIndexed: byProvider.reduce((sum, row) => sum + row.messagesIndexed, 0),
      providers: byProvider,
      backfill: this.backfill,
      filesPending: this.stale.size,
      lastIndexedAt: this.lastIndexedAt
    }
  }

  get failures(): number {
    return this.applyFailures
  }

  close(): void {
    this.db.close()
  }

  private logQuery(query: string, route: string, hits: number, durationMs: number): void {
    try {
      this.db
        .prepare(
          'INSERT INTO search_log(ts, query, route, hits, duration_ms) VALUES (?, ?, ?, ?, ?)'
        )
        .run(new Date().toISOString(), query, route, hits, durationMs)
      this.db
        .prepare(
          `DELETE FROM search_log WHERE id <= (
             SELECT id FROM search_log ORDER BY id DESC LIMIT 1 OFFSET ?)`
        )
        .run(SEARCH_LOG_LIMIT)
    } catch (error) {
      this.onError(error)
    }
  }
}
