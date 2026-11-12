import { join } from 'node:path'
import type { TerminalHistoryOutcome } from '../../protocol/daemon-history-protocol'
import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import type { TerminalHistorySessionWriter } from '../storage/terminal-history-session-writer'
import { LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import { TerminalJournalBacklog } from './terminal-session-journal-backlog'
import type {
  TerminalHistoryCut,
  TerminalHistoryImage,
  TerminalJournalOutput,
  TerminalJournalSession,
  TerminalSessionJournalHost
} from './terminal-session-journal-contract'
import { replayTerminalJournalSource } from './terminal-session-journal-source'

export const JOURNAL_READ_PRIORITY = 1

type JournalState = 'open' | 'gap'

/** A journal's identity, cuts and read-only replays; the writing side extends it. */
export class TerminalSessionJournalReads {
  readonly dir: string
  protected incarnationId = ''
  protected boundSession: TerminalJournalSession | null = null
  protected output: TerminalJournalOutput | null = null
  protected state: JournalState = 'open'
  protected writer: TerminalHistorySessionWriter | null = null
  protected readonly queue = new TerminalJournalBacklog()
  protected seq = 0
  protected foldGeneration = 0
  protected folded = false
  constructor(
    protected readonly host: TerminalSessionJournalHost,
    root: string,
    dirName: string,
    protected readonly origin: {
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
      // A cut that read nothing from files holds its whole source, whatever was published since.
      const selfContained = cut?.generation === 0 && cut.logBytes <= LOG_HEADER_BYTES
      if (
        !cut ||
        cut.gapped ||
        this.gapped ||
        (cut.generation !== this.foldGeneration && !selfContained) ||
        opts.isCanceled?.()
      ) {
        return null
      }
      const snapshot = await this.replay(cut.logBytes, cut.records, { ...opts, selfContained })
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

  gap(reason: string): void {
    if (this.state === 'gap') {
      return
    }
    this.state = 'gap'
    this.host.log('terminal-history-gap', { reason, incarnationId: this.incarnationId })
    this.host.charge(this, -this.queue.clear())
  }

  protected replay(
    logBytes: number,
    pending: readonly PendingOutputRecord[],
    opts: { scrollbackRows?: number; isCanceled?: () => boolean; selfContained?: boolean } = {}
  ): Promise<TerminalSnapshot | null> {
    return replayTerminalJournalSource(
      {
        dir: this.dir,
        generation: opts.selfContained ? 0 : (this.writer?.committedLog?.generation ?? 0),
        folded: !opts.selfContained && this.foldGeneration > 0,
        logBytes: opts.selfContained ? 0 : logBytes,
        pending,
        origin: this.origin
      },
      opts
    )
  }
}
