import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import { updateTerminalHistoryMeta } from '../storage/terminal-history-metadata'
import { hasReplayableTerminalHistorySessionFiles } from '../storage/terminal-history-session-files'
import {
  openTerminalJournalOrigin,
  publishTerminalJournalSeedOrigin
} from './terminal-session-journal-source'
import { TerminalSessionJournalReads } from './terminal-session-journal-reads'

export type { TerminalHistoryCut } from './terminal-session-journal-contract'

export const JOURNAL_SESSION_BACKLOG_BYTES = 8 * 1024 * 1024
export const JOURNAL_SESSION_BACKLOG_RECORDS = 10_000
export const JOURNAL_FOLD_PRIORITY = 0
export { JOURNAL_READ_PRIORITY } from './terminal-session-journal-reads'
// Bounds appends to about one per second per streaming session (base pulled every 5 s).
const JOURNAL_APPEND_WINDOW_MS = 1000
const JOURNAL_APPEND_BYTES = 64 * 1024

/**
 * The single ordered owner of one incarnation's applied output. It appends bounded batches,
 * folds the retained window into a checkpoint only at the log cap, and never rebases on reads.
 * A storage or backing failure gaps the incarnation for good: I/O continues, history does not.
 */
export class TerminalSessionJournal extends TerminalSessionJournalReads {
  private pumping: Promise<void> | null = null
  private appendTimer: ReturnType<typeof setTimeout> | null = null
  private flushing = 0
  private originRecords = 0
  private ending = false
  private finalized = false
  private sealedByFinalFlush = false
  private exitCode: number | null = null
  private readonly settledSignal = Promise.withResolvers<void>()
  private isSettled = false

  get settled(): Promise<void> {
    return this.settledSignal.promise
  }

  /** Called in applied order; the seed origin is exempt from the backlog bound it predates. */
  record(record: PendingOutputRecord, opts: { origin?: boolean } = {}): void {
    // Coalescing can change content without new intake; every applied call invalidates.
    this.markApplied()
    if (this.state !== 'open' || this.ending) {
      return
    }
    if (this.sealedByFinalFlush) {
      // Output after the final capture is not in it; never let reads claim it.
      this.gap('applied_after_final_flush')
      return
    }
    this.host.charge(this, this.queue.push(record))
    if (opts.origin) {
      // The seed stays whole so a predecessor-replacing checkpoint can cover exactly it.
      this.originRecords = this.queue.sealAll()
    } else if (
      this.queue.bytes > JOURNAL_SESSION_BACKLOG_BYTES ||
      this.queue.length > JOURNAL_SESSION_BACKLOG_RECORDS
    ) {
      this.gap('backlog_exhausted')
      return
    }
    // The origin opens promptly; later output waits for its append window.
    if (this.writer) {
      this.scheduleAppend()
    } else {
      this.kick()
    }
  }

  /** Commit everything applied so far; a final flush also stops later clean-end marking. */
  async flush(opts: { final?: boolean } = {}): Promise<boolean> {
    const target = this.queue.intake
    if (opts.final) {
      this.sealedByFinalFlush = true
    }
    this.flushing += 1
    try {
      do {
        this.kick()
        await this.pumping
      } while (this.state === 'open' && this.queue.committed < target)
    } finally {
      this.flushing -= 1
    }
    return this.state === 'open' && this.writer !== null
  }

  /** Physical exit or disposal: drain what was applied, then end cleanly only if nothing gapped. */
  finish(exitCode: number | null): void {
    if (this.ending) {
      return
    }
    this.ending = true
    this.exitCode = exitCode
    this.markApplied()
    this.kick()
  }

  /** Start failed after the hold: never write an origin for a process that does not exist. */
  abandon(): void {
    this.gap('abandoned')
    this.finish(null)
  }

  // Separate output callbacks share one append per window; a full batch need not wait.
  private scheduleAppend(): void {
    if (this.queue.bytes >= JOURNAL_APPEND_BYTES) {
      this.kick()
      return
    }
    if (this.appendTimer || this.pumping || this.isSettled) {
      return
    }
    this.appendTimer = setTimeout(() => this.kick(), JOURNAL_APPEND_WINDOW_MS)
    this.appendTimer.unref?.()
  }

  private get urgent(): boolean {
    return this.ending || this.flushing > 0 || this.queue.bytes >= JOURNAL_APPEND_BYTES
  }

  private kick(): void {
    if (this.appendTimer) {
      clearTimeout(this.appendTimer)
      this.appendTimer = null
    }
    if (this.pumping || this.isSettled) {
      return
    }
    // Start after the caller's synchronous turn: the seeding Session is still being constructed.
    const run = Promise.resolve()
      .then(() => this.pump())
      .catch((error: unknown) =>
        this.gap(error instanceof Error ? error.message : 'terminal_history_write_failed')
      )
      .finally(() => {
        this.pumping = null
        if (this.state === 'open' && (this.ending ? !this.finalized : this.queue.length > 0)) {
          // Output that arrived during this append waits for its own window unless forced.
          if (this.urgent) {
            this.kick()
          } else {
            this.scheduleAppend()
          }
        } else if (this.ending) {
          this.settle()
        }
      })
    this.pumping = run
  }

  private async pump(): Promise<void> {
    if (this.state === 'open' && !this.writer) {
      await this.openOrigin()
    }
    let first = true
    while (
      this.state === 'open' &&
      this.writer &&
      this.queue.length > 0 &&
      (first || this.urgent)
    ) {
      first = false
      const batch = this.queue.take()
      const appended = await this.writer.appendIncrements(this.seq + 1, batch.data)
      if (this.state !== 'open') {
        return
      }
      if (appended === 'ok') {
        this.seq += 1
        this.committedLogBytes = this.writer.committedLog?.bytes ?? 0
        this.host.charge(this, -this.queue.commit(batch.records, batch.headOffset))
        continue
      }
      await this.fold()
    }
    if (!this.ending || this.state !== 'open' || this.queue.length > 0) {
      return
    }
    this.finalized = true
    if (this.writer && !this.sealedByFinalFlush) {
      updateTerminalHistoryMeta(this.dir, {
        endedAt: new Date().toISOString(),
        exitCode: this.exitCode
      })
    }
  }

  // An explicit new physical origin: predecessor files are superseded only by a seeded origin.
  private async openOrigin(): Promise<void> {
    const seeded = this.boundSession?.historySeeded === true
    if (this.origin.preservesRecovery && !seeded) {
      this.gap('unseeded_recovery_preserved')
      return
    }
    if (
      !seeded ||
      this.originRecords === 0 ||
      !hasReplayableTerminalHistorySessionFiles(this.dir)
    ) {
      this.writer = openTerminalJournalOrigin(this.dir, this.origin)
      this.committedLogBytes = 0
      return
    }
    // Predecessor files stay the sole recovery until the seed's checkpoint is durable.
    const release = await this.host.acquireReplay(JOURNAL_FOLD_PRIORITY)
    try {
      if (this.state !== 'open') {
        return
      }
      const seed = this.queue.snapshot().slice(0, this.originRecords)
      const writer = await publishTerminalJournalSeedOrigin(this.dir, this.origin, seed)
      if (this.state !== 'open') {
        return
      }
      this.writer = writer
      this.committedLogBytes = writer.committedLog?.bytes ?? 0
      this.markApplied()
      this.foldGeneration += 1
      this.host.charge(this, -this.queue.commit(this.originRecords, 0))
    } finally {
      release()
    }
  }

  /** Only at the log cap: one parser rebuilds the retained window, then staged publication. */
  private async fold(): Promise<void> {
    const release = await this.host.acquireReplay(JOURNAL_FOLD_PRIORITY)
    try {
      const writer = this.writer
      const committed = writer?.committedLog
      if (!writer || !committed || this.state !== 'open') {
        return
      }
      const covered = this.queue.sealAll()
      const cut = this.captureCut()
      const records = cut.records
      const snapshot = await this.replay(committed.bytes, (index) => records[index])
      if (!snapshot || this.state !== 'open') {
        throw new Error('terminal_history_fold_replay_failed')
      }
      // Rename publishes the new generation; a failed header reset then gaps rather than reopen it.
      const result = await writer.checkpoint(snapshot, { pendingOutputSeq: this.seq })
      if (result.result !== 'committed') {
        throw result.error
      }
      this.foldGeneration += 1
      this.folded = true
      this.committedLogBytes = writer.committedLog?.bytes ?? 0
      this.markApplied()
      this.host.charge(this, -this.queue.commit(covered, 0))
    } finally {
      release()
    }
  }

  private settle(): void {
    if (this.isSettled || this.pumping) {
      return
    }
    this.isSettled = true
    this.settledSignal.resolve()
    this.host.settled(this)
  }
}
