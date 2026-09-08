import type { AiVaultSearchIndexingProgress } from '../../shared/ai-vault-search-types'

/** Observes the existing backfill and writer; owns no work or timers. */
export class SessionSearchIndexingProgress {
  private value: AiVaultSearchIndexingProgress = {
    phase: 'idle',
    filesProcessed: 0,
    filesTotal: null,
    failures: 0,
    startedAt: Date.now()
  }
  private paused = false
  private backfilling = false
  private activeWrites = 0
  private lastWriteAt = 0
  // Why: a failed backfill keeps the badge red until it is retried, but a
  // transient write failure must not outlive the next successful write.
  private failedWrite = false

  snapshot(): AiVaultSearchIndexingProgress {
    return { ...this.value, ...(this.paused ? { phase: 'paused' as const } : {}) }
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  discover(): void {
    this.backfilling = true
    this.failedWrite = false
    this.value = {
      phase: 'discovering',
      filesProcessed: 0,
      filesTotal: null,
      failures: 0,
      startedAt: Date.now()
    }
  }

  discovered(total: number, scanIssues: number): void {
    this.value = { ...this.value, phase: 'indexing', filesTotal: total, failures: scanIssues }
  }

  processed(failed: boolean): void {
    this.value.filesProcessed++
    if (failed) {
      this.value.failures++
    }
  }

  finish(failed = false): void {
    this.backfilling = false
    this.value.phase = failed || this.value.failures > 0 ? 'error' : 'complete'
  }

  beginWrite(): () => void {
    this.activeWrites++
    if (!this.backfilling && !this.paused && (this.value.phase !== 'error' || this.failedWrite)) {
      // Why rebuild on failedWrite: the superseded batch's counts describe the pass
      // that failed, and the panel keeps rendering its failure count after recovery.
      if (this.activeWrites === 1 && (this.failedWrite || Date.now() - this.lastWriteAt > 1000)) {
        this.value = {
          phase: 'updating',
          filesProcessed: 0,
          filesTotal: 0,
          failures: 0,
          startedAt: Date.now()
        }
      }
      this.value.phase = 'updating'
      this.value.filesTotal = (this.value.filesTotal ?? 0) + 1
    }
    const batch = this.value
    return () => {
      this.activeWrites--
      this.lastWriteAt = Date.now()
      if (!this.backfilling && batch === this.value && this.value.phase === 'updating') {
        this.value.filesProcessed++
        if (this.activeWrites === 0) {
          this.value.phase = 'complete'
          this.value.failures = 0
          this.failedWrite = false
        }
      }
    }
  }

  writeFailed(): void {
    if (!this.backfilling) {
      this.failedWrite = true
      this.value.failures++
      this.value.phase = 'error'
    }
  }
}
