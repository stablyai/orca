import { LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import {
  replaceTerminalHistoryMetaOwned,
  type TerminalHistoryMetaReplacement
} from '../storage/terminal-history-metadata'
import {
  isLiteralHostCwd,
  type TerminalHistoryCwdObservation
} from '../storage/terminal-history-cwd-observation'
import type { FlushHistoryUnavailableReason } from '../../protocol/daemon-history-protocol'
import type { TerminalJournalCwdNote } from './terminal-session-journal-contract'
import { TerminalSessionJournalReads } from './terminal-session-journal-reads'
import {
  TerminalJournalOperation,
  type TerminalJournalFinalReceipt,
  type TerminalJournalOperationFailure,
  type TerminalJournalOperationKind
} from './terminal-journal-operation'

/**
 * The journal's one admitted commit or Sleep: its immutable cut C, the ordered folder note at
 * C, and C's durable publication; the slot frees only at a terminal state.
 */
export abstract class TerminalSessionJournalOperations extends TerminalSessionJournalReads {
  protected operation: TerminalJournalOperation | null = null
  /** The authorized Sleep: its exit skips the clean end and publishes the final cut instead. */
  protected sleepFinal: TerminalJournalOperation | null = null
  protected ending = false
  /** An admitted operation needs affirmative backing that no committed record supplies yet. */
  protected needsEmptyBacking = false

  protected abstract kick(): void

  /** Admits C after the caller's barriers; a second overlapping operation is refused. */
  admitOperation(
    kind: TerminalJournalOperationKind,
    observation: string | undefined
  ): TerminalJournalOperation | FlushHistoryUnavailableReason {
    if (this.operation) {
      return 'busy'
    }
    if (this.state === 'gap') {
      return 'gap'
    }
    if (!this.session || this.ending) {
      return 'absent'
    }
    const valid = isLiteralHostCwd(observation) ? observation : null
    const record = this.queue.committed + this.queue.length
    // The previous effective note stays the answer if this one never publishes.
    const previousNote = this.cwdNote
    const note = valid ? { cwd: valid, record } : null
    if (note) {
      // Only a real observation boundary is sealed; later output may not coalesce across it.
      this.queue.sealAll()
      this.queue.cutAt = record
      this.cwdNote = note
      this.markApplied()
    }
    const operation = new TerminalJournalOperation(
      kind,
      this.incarnationId,
      valid,
      {
        record,
        appliedRevision: this.appliedRevision,
        outputSequence: this.output?.outputSequence() ?? 0,
        terminalOwner: this.output?.terminalOwner()
      },
      valid ? 'published' : observation === undefined ? 'none' : 'rejected'
    )
    operation.note = note
    operation.previousNote = note ? previousNote : null
    this.operation = operation
    if (this.queue.length === 0 && this.committedLogBytes === 0 && this.foldGeneration === 0) {
      this.needsEmptyBacking = true
    }
    // The pump publishes C, even for a quiet cut that settled backing already covers.
    this.kick()
    return operation
  }

  /** Whether whole records with real backing now cover the admitted cut C. */
  protected coveredAdmitted(): boolean {
    const operation = this.operation
    return (
      operation?.state === 'admitted' &&
      this.writer !== null &&
      this.queue.committed >= operation.cut.record &&
      (this.committedLogBytes > LOG_HEADER_BYTES || this.foldGeneration > 0)
    )
  }

  /** Pump only, after each step that can cover C: publishes it once, before C can be passed. */
  protected async publishCovered(): Promise<void> {
    const operation = this.operation
    const writer = this.writer
    if (!operation || !writer || !this.coveredAdmitted()) {
      return
    }
    const position = {
      generation: writer.committedLog?.generation ?? 0,
      logBytes: this.committedLogBytes
    }
    const note = operation.note
    // Unless a fold already carried it into its checkpoint, this note publishes here.
    if (note && this.cwdNote === note) {
      // Exactly this operation, note and covered prefix, on the open current journal.
      const current = (): boolean =>
        this.operation === operation &&
        operation.state === 'admitted' &&
        this.cwdNote === note &&
        this.writer === writer &&
        this.committedLogBytes === position.logBytes &&
        (writer.committedLog?.generation ?? 0) === position.generation &&
        this.ownsDirectory()
      const replaced = await this.publishNote({ cwd: note.cwd, ...position }, current)
      if (!current()) {
        // A gap already ended this operation; its late file result changes nothing newer.
        return
      }
      if (replaced !== 'replaced') {
        // The last acknowledged folder stays effective; this one was never saved.
        this.cwdNote = operation.previousNote
        this.queue.cutAt = null
        this.markApplied()
        this.failOperation(operation, {
          phase: 'preflight',
          reason: replaced === 'unrepresentable' ? 'unrepresentable' : 'write_failed'
        })
        return
      }
      this.cwdNote = { cwd: note.cwd, ...position }
    }
    this.queue.cutAt = null
    operation.state = 'published'
    operation.publication.resolve(position)
    if (operation.kind === 'commit') {
      this.endOperation(operation)
    }
  }

  /** Whether this operation still holds the journal's slot. */
  holdsOperation(operation: TerminalJournalOperation): boolean {
    return this.operation === operation
  }

  /**
   * The note a fold captured and applied now lives in its checkpoint. A note admitted after that
   * capture, even at the same record boundary, was not applied and still publishes.
   */
  protected settleFoldedNote(applied: TerminalJournalCwdNote | null): void {
    if (!applied) {
      return
    }
    const operation = this.operation
    if (this.cwdNote === applied) {
      this.cwdNote = null
      if (operation?.note === applied && operation.state === 'admitted') {
        operation.cwdNote = 'folded'
      }
    }
    if (operation?.previousNote === applied) {
      // A failed replacement now falls back to the checkpoint that holds this folder.
      operation.previousNote = null
    }
  }

  protected publishNote(
    note: TerminalHistoryCwdObservation,
    isOwner: () => boolean
  ): Promise<TerminalHistoryMetaReplacement> {
    return replaceTerminalHistoryMetaOwned(
      this.dir,
      (meta) => ({ ...meta, cwdObservation: note }),
      isOwner
    )
  }

  protected ownsDirectory(): boolean {
    return this.state === 'open' && this.host.owns(this)
  }

  override gap(reason: string): void {
    super.gap(reason)
    const operation = this.operation
    if (operation) {
      const phase =
        operation.state === 'final'
          ? 'exited'
          : operation.state === 'authorized'
            ? 'authorized'
            : 'preflight'
      this.failOperation(operation, { phase, reason: 'gap' })
    }
  }

  protected failOperation(
    operation: TerminalJournalOperation,
    failure: TerminalJournalOperationFailure
  ): void {
    if (operation.state === 'done') {
      return
    }
    operation.failure = failure
    // Queued verification stops; issued reads and writes keep their leases until they settle.
    operation.cancel.abort(new Error('operation_ended'))
    operation.publication.resolve(null)
    operation.outcome.resolve(failure)
    this.endOperation(operation)
  }

  protected completeOperation(
    operation: TerminalJournalOperation,
    receipt: TerminalJournalFinalReceipt
  ): void {
    operation.outcome.resolve(receipt)
    this.endOperation(operation)
  }

  // Drops the operation's logical references; issued file and parser work keeps its own leases.
  private endOperation(operation: TerminalJournalOperation): void {
    operation.state = 'done'
    operation.finalCut = null
    if (this.operation === operation) {
      this.operation = null
    }
  }
}
