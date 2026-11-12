import { join } from 'node:path'
import type { TerminalHistoryOutcome } from '../../protocol/daemon-history-protocol'
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import type { TerminalHistorySessionWriter } from '../storage/terminal-history-session-writer'
import { updateTerminalHistoryMeta } from '../storage/terminal-history-metadata'
import { TerminalJournalBacklog } from './terminal-session-journal-backlog'
import type {
  TerminalHistoryCut,
  TerminalHistoryImage,
  TerminalJournalOutput,
  TerminalJournalSession,
  TerminalSessionJournalHost
} from './terminal-session-journal-contract'
import {
  openTerminalJournalOrigin,
  replayTerminalJournalSource
} from './terminal-session-journal-source'

export type { TerminalHistoryCut } from './terminal-session-journal-contract'

export const JOURNAL_SESSION_BACKLOG_BYTES = 8 * 1024 * 1024
export const JOURNAL_SESSION_BACKLOG_RECORDS = 10_000
export const JOURNAL_FOLD_PRIORITY = 0
export const JOURNAL_READ_PRIORITY = 1

type JournalState = 'open' | 'gap'

/**
 * The single ordered owner of one incarnation's applied output. It appends bounded batches,
 * folds the retained window into a checkpoint only at the log cap, and never rebases on reads.
 * A storage or backing failure gaps the incarnation for good: I/O continues, history does not.
 */
export class TerminalSessionJournal {
  readonly dir: string
  private incarnationId = ''
  private boundSession: TerminalJournalSession | null = null
  private output: TerminalJournalOutput | null = null
  private state: JournalState = 'open'
  private writer: TerminalHistorySessionWriter | null = null
  private readonly queue = new TerminalJournalBacklog()
  private seq = 0
  private foldGeneration = 0
  private folded = false
  private pumping: Promise<void> | null = null
  private ending = false
  private finalized = false
  private sealedByFinalFlush = false
  private exitCode: number | null = null
  private readonly settledSignal = Promise.withResolvers<void>()
  private isSettled = false

  constructor(
    private readonly host: TerminalSessionJournalHost,
    root: string,
    dirName: string,
    private readonly origin: {
      cwd: string
      cols: number
      rows: number
      wslDistro: string | undefined
      /** Restorable predecessor recovery stays unless this incarnation was seeded from it. */
      preservesRecovery: boolean
    }
  ) {
    this.dir = join(root, dirName)
  }

  get backlog(): number {
    return this.queue.bytes
  }

  get gapped(): boolean {
    return this.state === 'gap'
  }

  get settled(): Promise<void> {
    return this.settledSignal.promise
  }

  get incarnation(): string {
    return this.incarnationId
  }

  /** The live owner this journal serves; reads and flushes act only while it lives. */
  get session(): TerminalJournalSession | null {
    return this.boundSession?.isAlive ? this.boundSession : null
  }

  bindSession(session: TerminalJournalSession): void {
    this.incarnationId = session.incarnationId
    this.boundSession = session
  }

  bindOutput(output: TerminalJournalOutput): void {
    this.output = output
  }

  /** Exact attach-attempt membership: a superseded attempt no longer holds its token. */
  hasAttachedClient(token: symbol): boolean {
    return this.output?.hasAttachedClient(token) === true
  }

  /** Called in applied order; the seed origin is exempt from the backlog bound it predates. */
  record(record: PendingOutputRecord, opts: { origin?: boolean } = {}): void {
    if (this.state !== 'open' || this.ending) {
      return
    }
    if (this.sealedByFinalFlush) {
      // Output after the final capture is not in it; never let reads claim it.
      this.gap('applied_after_final_flush')
      return
    }
    this.host.charge(this, this.queue.push(record))
    if (
      !opts.origin &&
      (this.queue.bytes > JOURNAL_SESSION_BACKLOG_BYTES ||
        this.queue.length > JOURNAL_SESSION_BACKLOG_RECORDS)
    ) {
      this.gap('backlog_exhausted')
      return
    }
    this.kick()
  }

  /** Synchronous with the live stream position so replay and later delivery meet exactly. */
  captureCut(): TerminalHistoryCut {
    const records = this.queue.snapshot()
    return {
      generation: this.foldGeneration,
      logBytes: this.writer?.committedLog?.bytes ?? 0,
      records,
      outputSequence: this.output?.outputSequence() ?? 0,
      terminalOwner: this.output?.terminalOwner(),
      gapped: this.state === 'gap'
    }
  }

  /** Read-only: replays the cut through one parser without touching storage or the live model. */
  async readImage(
    cutOrCapture: TerminalHistoryCut | (() => TerminalHistoryCut | null),
    opts: { scrollbackRows?: number; isCanceled?: () => boolean } = {}
  ): Promise<TerminalHistoryImage | null> {
    if (this.state === 'gap') {
      return null
    }
    // Admission precedes any capture a reader makes, so waiting readers pin no copies.
    const release = await this.host.acquireReplay(JOURNAL_READ_PRIORITY)
    try {
      const cut = typeof cutOrCapture === 'function' ? cutOrCapture() : cutOrCapture
      if (
        !cut ||
        cut.gapped ||
        this.gapped ||
        cut.generation !== this.foldGeneration ||
        opts.isCanceled?.()
      ) {
        return null
      }
      const snapshot = await this.replay(cut.logBytes, cut.records, opts)
      return snapshot
        ? {
            snapshot: {
              ...snapshot,
              outputSequence: cut.outputSequence,
              ...(cut.terminalOwner ? { terminalOwner: cut.terminalOwner } : {})
            },
            outcome: {
              kind: this.folded ? ('fold' as const) : ('origin' as const),
              incarnationId: this.incarnationId,
              outputSequence: cut.outputSequence
            }
          }
        : null
    } catch {
      return null
    } finally {
      release()
    }
  }

  outcome(outputSequence: number): TerminalHistoryOutcome {
    return {
      kind: this.state === 'gap' ? 'gap' : this.folded ? 'fold' : 'origin',
      incarnationId: this.incarnationId,
      outputSequence
    }
  }

  /** Commit everything applied so far; a final flush also stops later clean-end marking. */
  async flush(opts: { final?: boolean } = {}): Promise<boolean> {
    const target = this.queue.intake
    if (opts.final) {
      this.sealedByFinalFlush = true
    }
    do {
      this.kick()
      await this.pumping
    } while (this.state === 'open' && this.queue.committed < target)
    return this.state === 'open' && this.writer !== null
  }

  /** Physical exit or disposal: drain what was applied, then end cleanly only if nothing gapped. */
  finish(exitCode: number | null): void {
    if (this.ending) {
      return
    }
    this.ending = true
    this.exitCode = exitCode
    this.kick()
  }

  /** Start failed after the hold: never write an origin for a process that does not exist. */
  abandon(): void {
    this.gap('abandoned')
    this.finish(null)
  }

  gap(reason: string): void {
    if (this.state === 'gap') {
      return
    }
    this.state = 'gap'
    this.host.log('terminal-history-gap', { reason, incarnationId: this.incarnationId })
    this.host.charge(this, -this.queue.clear())
  }

  private kick(): void {
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
        if (this.state === 'open' && (this.queue.length > 0 || (this.ending && !this.finalized))) {
          this.kick()
        } else if (this.ending) {
          this.settle()
        }
      })
    this.pumping = run
  }

  private async pump(): Promise<void> {
    if (this.state === 'open' && !this.writer) {
      this.openOrigin()
    }
    while (this.state === 'open' && this.writer && this.queue.length > 0) {
      const batch = this.queue.take()
      const appended = await this.writer.appendIncrements(this.seq + 1, batch.data)
      if (this.state !== 'open') {
        return
      }
      if (appended === 'ok') {
        this.seq += 1
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
  private openOrigin(): void {
    if (this.origin.preservesRecovery && this.boundSession?.historySeeded !== true) {
      this.gap('unseeded_recovery_preserved')
      return
    }
    this.writer = openTerminalJournalOrigin(this.dir, this.origin)
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
      const snapshot = await this.replay(committed.bytes, cut.records)
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
      this.host.charge(this, -this.queue.commit(covered, 0))
    } finally {
      release()
    }
  }

  private replay(
    logBytes: number,
    pending: readonly PendingOutputRecord[],
    opts: { scrollbackRows?: number; isCanceled?: () => boolean } = {}
  ): Promise<TerminalSnapshot | null> {
    return replayTerminalJournalSource(
      {
        dir: this.dir,
        generation: this.writer?.committedLog?.generation ?? 0,
        folded: this.foldGeneration > 0,
        logBytes,
        pending,
        origin: this.origin
      },
      opts
    )
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
