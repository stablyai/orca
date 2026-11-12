import { join } from 'node:path'
import type { TerminalHistoryOutcome } from '../../protocol/daemon-history-protocol'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import type { TerminalHistorySessionWriter } from '../storage/terminal-history-session-writer'
import { LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import { TerminalJournalBacklog } from './terminal-session-journal-backlog'
import type {
  TerminalHistoryCut,
  TerminalHistoryImage,
  TerminalHistoryReadCut,
  TerminalJournalOutput,
  TerminalJournalSession,
  TerminalSessionJournalHost
} from './terminal-session-journal-contract'
import {
  replayTerminalJournalSource,
  type TerminalJournalSource
} from './terminal-session-journal-source'
import { RevocablePendingSource } from './terminal-history-pending-source'
import {
  derivedImageCharge,
  type DerivedHistoryImage,
  type DerivedImageLease
} from './terminal-history-derived-image'

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
  /** Log bytes committed together with the queue head, so a cut never counts a batch twice. */
  protected committedLogBytes = 0
  /** Bumped by every applied record and every transition that can change a derived answer. */
  protected appliedRevision = 0
  private derived: DerivedHistoryImage | null = null
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
    this.markApplied()
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
      logBytes: this.committedLogBytes,
      records,
      outputSequence: this.output?.outputSequence() ?? 0,
      terminalOwner: this.output?.terminalOwner(),
      gapped: this.state === 'gap'
    }
  }

  /** Backing a reader's cut must reserve before copying: queued bytes and records. */
  get pendingSource(): { bytes: number; records: number } {
    return { bytes: this.queue.bytes, records: this.queue.length }
  }

  /** A reader's cut; only the returned handle holds the copied pending records. */
  captureReadCut(): TerminalHistoryReadCut {
    const { records, ...cut } = this.captureCut()
    return { ...cut, source: new RevocablePendingSource(records) }
  }

  /** The replay lease a reader holds from before its capture until its parser is disposed. */
  acquireRead(signal?: AbortSignal): Promise<() => void> {
    return this.host.acquireReplay(JOURNAL_READ_PRIORITY, signal)
  }

  /**
   * Exact qualification of a derived answer for this request shape, read after the caller's
   * barriers. Null while no answer can be derived. Incarnation, fold generation, every applied
   * transition, the stream position and the owner all take part.
   */
  derivedKey(scrollbackRows: number | undefined): string | null {
    if (this.state === 'gap' || !this.session) {
      return null
    }
    return JSON.stringify([
      this.incarnationId,
      this.foldGeneration,
      this.appliedRevision,
      scrollbackRows ?? null,
      this.output?.outputSequence() ?? 0,
      this.output?.terminalOwner() ?? null
    ])
  }

  /** The latest derived answer for exactly this key, leased; null when absent or stale. */
  leaseDerived(key: string): DerivedImageLease | null {
    const derived = this.derived
    return derived?.eligible && derived.key === key ? this.host.images.lease(derived) : null
  }

  /** Installs a fresh answer as the sole entry if its key is still current and it fits I. */
  offerDerived(
    key: string,
    scrollbackRows: number | undefined,
    image: TerminalHistoryImage
  ): DerivedHistoryImage | null {
    if (this.derivedKey(scrollbackRows) !== key) {
      return null
    }
    const entry: DerivedHistoryImage = {
      key,
      image,
      charge: derivedImageCharge(image),
      leases: 0,
      eligible: true,
      onEvict: () => {
        if (this.derived === entry) {
          this.derived = null
        }
      }
    }
    this.invalidateDerived()
    if (!this.host.images.admit(entry)) {
      return null
    }
    this.derived = entry
    return entry
  }

  protected markApplied(): void {
    this.appliedRevision += 1
    this.invalidateDerived()
  }

  protected invalidateDerived(): void {
    const derived = this.derived
    if (derived) {
      this.derived = null
      derived.eligible = false
      this.host.images.settle(derived)
    }
  }

  /** Replays the cut through one parser; the caller holds the replay lease from before capture. */
  async readImage(
    cut: TerminalHistoryReadCut,
    opts: { scrollbackRows?: number; isCanceled?: () => boolean } = {}
  ): Promise<TerminalHistoryImage | null> {
    // A cut that read nothing from files holds its whole source, whatever was published since.
    const selfContained = cut.generation === 0 && cut.logBytes <= LOG_HEADER_BYTES
    if (
      this.state === 'gap' ||
      cut.gapped ||
      (cut.generation !== this.foldGeneration && !selfContained) ||
      opts.isCanceled?.()
    ) {
      return null
    }
    try {
      const snapshot = await this.replay(cut.logBytes, cut.source, { ...opts, selfContained })
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
    this.markApplied()
    this.host.log('terminal-history-gap', { reason, incarnationId: this.incarnationId })
    this.host.charge(this, -this.queue.clear())
  }

  protected replay(
    logBytes: number,
    pending: TerminalJournalSource['pending'],
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
