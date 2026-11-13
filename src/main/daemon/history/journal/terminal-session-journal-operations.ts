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
    if (valid) {
      // Only a real observation boundary is sealed; later output may not coalesce across it.
      this.queue.sealAll()
      this.queue.cutAt = record
      this.cwdNote = { cwd: valid, record }
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
    this.operation = operation
    if (this.queue.length === 0 && this.committedLogBytes === 0 && this.foldGeneration === 0) {
      this.needsEmptyBacking = true
    }
    this.publishIfCovered()
    this.kick()
    return operation
  }

  /** After a commit, fold or origin: publishes C once whole records with real backing cover it. */
  protected publishIfCovered(): void {
    const operation = this.operation
    const writer = this.writer
    if (
      operation?.state !== 'admitted' ||
      !writer ||
      this.queue.committed < operation.cut.record ||
      (this.committedLogBytes <= LOG_HEADER_BYTES && this.foldGeneration === 0)
    ) {
      return
    }
    const position = {
      generation: writer.committedLog?.generation ?? 0,
      logBytes: this.committedLogBytes
    }
    const note = this.cwdNote
    if (note && 'record' in note && note.record === operation.cut.record) {
      const replaced = this.publishNote({ cwd: note.cwd, ...position })
      if (replaced !== 'replaced') {
        this.cwdNote = null
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

  /** A fold that covered the note carries it in its checkpoint; a later note keeps its boundary. */
  protected settleFoldedNote(): void {
    const note = this.cwdNote
    if (note && (!('record' in note) || note.record <= this.queue.committed)) {
      this.cwdNote = null
      if (this.operation?.observation && this.operation.state === 'admitted') {
        this.operation.cwdNote = 'folded'
      }
    }
  }

  protected publishNote(note: TerminalHistoryCwdObservation): TerminalHistoryMetaReplacement {
    return replaceTerminalHistoryMetaOwned(
      this.dir,
      (meta) => ({ ...meta, cwdObservation: note }),
      () => this.ownsDirectory()
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
