import type { FlushHistoryUnavailableReason } from '../../protocol/daemon-history-protocol'
import { LOG_HEADER_BYTES } from '../storage/terminal-history-log'
import type { TerminalJournalPhysicalFinal } from './terminal-session-journal-contract'
import { TerminalSessionJournalOperations } from './terminal-session-journal-operations'
import { verifyFinalCheckpoint, verifyFinalRaw } from './terminal-journal-final-verification'
import type {
  TerminalJournalOperation,
  TerminalJournalOperationFailure,
  TerminalJournalPosition
} from './terminal-journal-operation'

// The final publication is the journal's own fold-priority write.
const FINAL_PUBLICATION_PRIORITY = 0

type FinalPublication =
  | (TerminalJournalPosition & { backing: 'checkpoint' | 'raw' })
  | TerminalJournalOperationFailure

/**
 * Sleep's phases after C publishes: verification of the committed source K, authorization at
 * the existing Session reservation, and the physically final F publication with its proof.
 */
export abstract class TerminalSessionJournalSleep extends TerminalSessionJournalOperations {
  /**
   * Sleep preflight, owned by the journal rather than its waiter: after C publishes, take the
   * replay lease, capture the committed source K, prove it covers C and rebuild it from files.
   */
  preflightSleep(operation: TerminalJournalOperation): Promise<boolean> {
    operation.preflight ??= (async () => {
      const published = await operation.publication.promise
      const verified = published !== null && (await this.verifyCommitted(operation))
      if (operation.killDisabled || !verified) {
        this.failOperation(operation, {
          phase: 'preflight',
          reason: operation.killDisabled ? 'canceled' : 'unreadable'
        })
        return false
      }
      return true
    })()
    return operation.preflight
  }

  private async verifyCommitted(operation: TerminalJournalOperation): Promise<boolean> {
    let release: (() => void) | null = null
    try {
      release = await this.acquireRead(operation.cancel.signal)
      // K: the committed descriptor now, which may already include a covering complete fold.
      const record = this.queue.committed
      if (
        this.operation !== operation ||
        this.state === 'gap' ||
        !this.session ||
        record < operation.cut.record
      ) {
        return false
      }
      const snapshot = await this.replay(this.committedLogBytes, () => undefined, {
        firstRecord: record,
        cwdNote: this.cwdNote,
        isCanceled: () => operation.cancel.signal.aborted
      })
      return snapshot !== null
    } catch {
      return false
    } finally {
      release?.()
    }
  }

  /** A pre-authorization waiter left: this Sleep never kills, and frees after its issued I/O. */
  cancelSleep(operation: TerminalJournalOperation): void {
    if (operation.state === 'authorized' || operation.state === 'final') {
      return
    }
    operation.killDisabled = true
    operation.cancel.abort(new Error('canceled'))
    void (operation.preflight ?? operation.publication.promise).then(() =>
      this.failOperation(operation, { phase: 'preflight', reason: 'canceled' })
    )
  }

  /** Authorization was refused before any termination: the process keeps running normally. */
  refuseSleep(operation: TerminalJournalOperation, reason: FlushHistoryUnavailableReason): void {
    if (operation.state !== 'authorized' && operation.state !== 'final') {
      this.failOperation(operation, { phase: 'preflight', reason })
    }
  }

  /** The existing Session reservation accepted this Sleep, before an exit can be delivered. */
  authorizeSleep(operation: TerminalJournalOperation): void {
    operation.state = 'authorized'
    this.sleepFinal = operation
  }

  /** The teardown settled with the exact process alive and unowned: its signal was refused. */
  rollbackSleep(operation: TerminalJournalOperation): void {
    if (this.sleepFinal === operation && operation.state === 'authorized') {
      this.sleepFinal = null
      this.failOperation(operation, { phase: 'preflight', reason: 'refused' })
    }
  }

  /** Physical exit supplies F; any other ending leaves this recovery operation unavailable. */
  protected captureFinalCut(final: TerminalJournalPhysicalFinal | undefined): void {
    const operation = this.operation
    if (!operation) {
      return
    }
    if (this.sleepFinal !== operation) {
      // Ended before authorization: a natural exit is never this Sleep's receipt.
      if (operation.kind === 'sleep') {
        this.failOperation(operation, { phase: 'preflight', reason: 'exited' })
      }
      return
    }
    if (!final) {
      this.failOperation(operation, { phase: 'authorized', reason: 'gap' })
      return
    }
    operation.state = 'final'
    operation.finalCut = { record: this.queue.intake, ...final }
  }

  /** At the drained end of an authorized Sleep, publish F. True when the clean end is skipped. */
  protected async completeSleepFinal(): Promise<boolean> {
    const operation = this.sleepFinal
    if (!operation) {
      return false
    }
    const final = operation.finalCut
    if (operation.state !== 'final' || !final) {
      return true
    }
    try {
      const { terminalOwner } = await final.settled
      // The receipt's revision is read once the captured parser fence has settled.
      const appliedRevision = this.appliedRevision
      const published = await this.publishFinal(operation, terminalOwner)
      if ('reason' in published) {
        this.failOperation(operation, published)
      } else {
        this.completeOperation(operation, {
          ...published,
          appliedRevision,
          outputSequence: final.outputSequence
        })
      }
    } catch {
      this.failOperation(operation, { phase: 'exited', reason: 'write_failed' })
    }
    return true
  }

  private async publishFinal(
    operation: TerminalJournalOperation,
    terminalOwner: TerminalJournalOperation['cut']['terminalOwner']
  ): Promise<FinalPublication> {
    const release = await this.host.acquireReplay(FINAL_PUBLICATION_PRIORITY)
    try {
      const writer = this.writer
      if (this.state !== 'open' || !writer || this.queue.committed !== operation.finalCut?.record) {
        return { phase: 'exited', reason: 'gap' }
      }
      const position = {
        generation: writer.committedLog?.generation ?? 0,
        logBytes: this.committedLogBytes
      }
      const snapshot = await this.replay(position.logBytes, () => undefined, {
        firstRecord: this.queue.committed,
        cwdNote: this.cwdNote
      })
      if (!snapshot) {
        return { phase: 'exited', reason: 'unreadable' }
      }
      // The final Sleep probe is the folder at F, whatever the replayed output reported last.
      const image = {
        ...snapshot,
        cwd: operation.observation ?? snapshot.cwd,
        ...(terminalOwner ? { terminalOwner } : {})
      }
      const strict = await writer.checkpointStrict(image, { pendingOutputSeq: this.seq })
      if (strict.result === 'committed') {
        this.committedLogBytes = writer.committedLog?.bytes ?? LOG_HEADER_BYTES
        return verifyFinalCheckpoint(this.dir, strict.data, strict.generation)
          ? { generation: strict.generation, logBytes: LOG_HEADER_BYTES, backing: 'checkpoint' }
          : { phase: 'exited', reason: 'write_failed' }
      }
      if (strict.result === 'retryable') {
        return { phase: 'exited', reason: 'write_failed' }
      }
      // Too large for one strict image: the verified complete raw source through F is the backing.
      const note = operation.observation ? { cwd: operation.observation, ...position } : undefined
      if (note && this.publishNote(note) !== 'replaced') {
        return { phase: 'exited', reason: 'write_failed' }
      }
      return verifyFinalRaw(this.dir, position, note)
        ? { ...position, backing: 'raw' }
        : { phase: 'exited', reason: 'write_failed' }
    } finally {
      release()
    }
  }
}
