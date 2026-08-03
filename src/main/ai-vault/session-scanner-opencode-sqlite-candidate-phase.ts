import { looksLikeOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import type { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import { hasFreshSessionParseCacheEntry } from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'

export class OpenCodeSqliteCandidatePhase {
  private remainingCandidates: number
  private workerBoundBatch = new Set<SessionFileCandidate>()
  private readonly platform: NodeJS.Platform
  private readonly context: OpenCodeSqliteScanContext

  constructor(args: {
    candidates: readonly SessionFileCandidate[]
    platform: NodeJS.Platform
    context: OpenCodeSqliteScanContext
  }) {
    this.platform = args.platform
    this.context = args.context
    this.remainingCandidates = args.candidates.filter((candidate) =>
      looksLikeOpenCodeSqliteCandidate(candidate.file.path)
    ).length
    if (this.remainingCandidates === 0) {
      args.context.disarmDeadline()
    }
  }

  prepareBatch(batch: readonly SessionFileCandidate[]): SessionFileCandidate[] {
    this.workerBoundBatch = new Set()
    const prepared = batch.filter((candidate) => {
      if (!looksLikeOpenCodeSqliteCandidate(candidate.file.path)) {
        return true
      }
      this.remainingCandidates -= 1
      // Cache reuse is path+mtime based and never reaches the worker, so a spent
      // budget must not drop rows this scan can still serve for free — and a
      // cache-served row must not spend the budget either, since the budget
      // measures outstanding SQLite work.
      const servedFromCache = hasFreshSessionParseCacheEntry(candidate, this.platform)
      if (servedFromCache) {
        this.context.noteSqliteParseCacheHit()
        return true
      }
      if (this.context.isTerminated) {
        this.context.markWorkOmitted()
        return false
      }
      this.workerBoundBatch.add(candidate)
      return true
    })
    if (this.workerBoundBatch.size > 0) {
      this.context.armDeadline()
    }
    return prepared
  }

  trackBatch(
    candidates: readonly SessionFileCandidate[],
    promises: readonly Promise<unknown>[]
  ): void {
    // Pairs 1:1 with the arm in prepareBatch: only a batch that armed the clock
    // may pause it, or the reference count drifts.
    if (this.workerBoundBatch.size === 0) {
      return
    }
    const workerBound = this.workerBoundBatch
    this.workerBoundBatch = new Set()
    const sqlitePromises = promises.filter((_, index) => {
      const candidate = candidates[index]
      return candidate !== undefined && workerBound.has(candidate)
    })
    if (sqlitePromises.length === 0) {
      this.context.pauseDeadline()
      return
    }
    // Stop the budget clock as soon as this batch's SQLite work settles, even if
    // a co-scheduled parser for another agent is still running.
    const lastBatch = this.remainingCandidates === 0
    void Promise.allSettled(sqlitePromises).then(() =>
      lastBatch ? this.context.disarmDeadline() : this.context.pauseDeadline()
    )
  }

  finish(): void {
    this.context.disarmDeadline()
  }
}
