import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  StructuredAgentSessionEventTarget,
  StructuredAgentSessionReadingControl,
  StructuredAgentSessionSinkAdmission,
  StructuredAgentSessionSinkBarrier,
  StructuredAgentSessionSinkState,
  StructuredAgentSessionSinkWatermarks
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHistoryJournal } from './structured-agent-session-journal-views'
import { StructuredAgentSessionSinkSnapshots } from './structured-agent-session-sink-snapshots'
import {
  StructuredAgentSessionDispatch,
  runStructuredAgentSessionSinkOperation,
  type Admitted,
  type StructuredAgentSessionSinkOperation
} from './structured-agent-session-dispatch'

const MAX_PRE_CONTROL_OPERATIONS = 1_024
const MAX_PRE_CONTROL_BYTES = 32 * 1024 * 1024

/** Hand writes to the journal in issuance order; bound startup work until reading can pause. */
export class StructuredAgentSessionSinkQueue {
  private readingControl: StructuredAgentSessionReadingControl | undefined
  private hasBoundReadingControl: boolean
  private target: StructuredAgentSessionEventTarget | null = null
  private closed = false
  private failure: { error: unknown } | null = null
  private queuedBytes = 0
  private queuedOperations = 0
  private backpressured = false
  private acceptedSequence = 0
  private settledSequence = 0
  /** Closing drops only buffered operations after this handover sequence. */
  private handedOverSequence = 0
  private handedOverSettled: Promise<void> = Promise.resolve()
  private readonly buffered: Admitted[] = []
  private readonly dispatch = new StructuredAgentSessionDispatch(
    () => this.seal(),
    () => !this.closed && this.failure === null
  )
  private readonly waiters: {
    through: number
    resolve: (result: StructuredAgentSessionSinkBarrier) => void
  }[] = []
  private readonly settledTurnListeners = new Set<(turnItemIds: readonly string[]) => void>()
  private releaseSettledTurns: (() => void) | undefined
  private readingPaused = false
  bindLiveText = (
    source: Parameters<StructuredAgentSessionSinkSnapshots['bindLiveText']>[0]
  ): (() => void) => this.snapshots.bindLiveText(source)

  liveText = (): readonly AgentJournalRenderItem[] => {
    const target = this.target
    return !target || this.closed || this.failure !== null || this.snapshots.held
      ? []
      : this.snapshots.readLiveText(target.journal.cursor().epoch)
  }

  flushLiveText = (): void => {
    this.snapshots.flushLiveText()
  }

  publishLiveText = (): StructuredAgentSessionSinkAdmission =>
    this.submit({
      bytes: 1,
      publicationKey: 'live-text',
      run: (bound) => {
        if (this.target === bound) {
          bound.publishLiveText?.(this.liveText())
        }
      }
    })
  readonly snapshots = new StructuredAgentSessionSinkSnapshots(() => this.syncReading())

  constructor(
    private readonly deps: {
      watermarks: StructuredAgentSessionSinkWatermarks
      onFailed?: (error: unknown) => void
      readingControl?: StructuredAgentSessionReadingControl
      onBackpressureChange?: (
        backpressured: boolean,
        state: StructuredAgentSessionSinkState
      ) => void
    }
  ) {
    this.readingControl = deps.readingControl
    this.hasBoundReadingControl = deps.readingControl !== undefined
  }

  state = (): StructuredAgentSessionSinkState => ({
    queuedBytes: this.queuedBytes,
    queuedOperations: this.queuedOperations,
    backpressured: this.backpressured,
    failed: this.failure !== null
  })

  journalEpoch = (): string | null => this.target?.journal.cursor().epoch ?? null

  journalHistory = (): StructuredAgentSessionHistoryJournal | null => this.target?.journal ?? null

  observeSettledTurns = (listener: (turnItemIds: readonly string[]) => void): (() => void) => {
    const registered = (turnItemIds: readonly string[]) => listener(turnItemIds)
    this.settledTurnListeners.add(registered)
    return () => {
      this.settledTurnListeners.delete(registered)
    }
  }

  bindReadingControl(control: StructuredAgentSessionReadingControl): () => void {
    this.readingControl = control
    this.hasBoundReadingControl = true
    this.readingPaused = false
    this.syncReading()
    return () => {
      if (this.readingControl === control) {
        this.readingControl = undefined
      }
    }
  }

  bind(target: StructuredAgentSessionEventTarget): void {
    if (this.closed) {
      return
    }
    this.seal()
    this.target = target
    this.releaseSettledTurns?.()
    this.releaseSettledTurns = target.observeSettledTurns?.((turnItemIds) => {
      for (const listener of this.settledTurnListeners) {
        listener(turnItemIds)
      }
    })
    for (const operation of this.buffered.splice(0)) {
      this.stage(operation, target)
    }
  }

  unbind(): void {
    this.seal()
    this.releaseSettledTurns?.()
    this.releaseSettledTurns = undefined
    this.target = null
  }

  close(): void {
    this.seal()
    this.releaseSettledTurns?.()
    this.releaseSettledTurns = undefined
    this.snapshots.close()
    this.closed = true
    this.dropBuffered()
    this.updateBackpressure()
  }

  barrier = (): Promise<StructuredAgentSessionSinkBarrier> => {
    this.flushLiveText()
    const through = this.acceptedSequence
    this.seal()
    return this.waitThrough(through)
  }

  private waitThrough(through: number): Promise<StructuredAgentSessionSinkBarrier> {
    if (this.settledSequence >= through) {
      return Promise.resolve(this.barrierResult())
    }
    return new Promise((resolve) => this.waiters.push({ through, resolve }))
  }

  /** Unlike barrier, report close-dropped admitted writes as not landed. */
  written = async (): Promise<StructuredAgentSessionSinkBarrier> => {
    this.flushLiveText()
    const through = this.acceptedSequence
    this.seal()
    const settled = await this.waitThrough(through)
    return settled.ok && this.handedOverSequence < through
      ? { ok: false, error: new Error('the sink closed before its writes landed') }
      : settled
  }

  submit(
    operation: Omit<StructuredAgentSessionSinkOperation, 'sequence'>
  ): StructuredAgentSessionSinkAdmission {
    if (this.closed) {
      return { accepted: false, reason: 'closed' }
    }
    if (this.failure !== null) {
      return { accepted: false, reason: 'failed' }
    }
    const key = operation.publicationKey
    const replaceAt =
      key === undefined ? -1 : this.buffered.findIndex((queued) => queued.publicationKey === key)
    const replaced = replaceAt >= 0 ? this.buffered[replaceAt] : undefined
    const queuedBytes = this.queuedBytes + operation.bytes - (replaced?.bytes ?? 0)
    const queuedOperations =
      this.queuedOperations +
      (operation.operations ?? 1) -
      (replaceAt >= 0 ? (replaced?.operations ?? 1) : 0)
    if (
      !this.hasBoundReadingControl &&
      (queuedBytes > MAX_PRE_CONTROL_BYTES || queuedOperations > MAX_PRE_CONTROL_OPERATIONS)
    ) {
      this.fail(new Error('Agent journal queue capacity exceeded before reading control bound'))
      return { accepted: false, reason: 'failed' }
    }
    const accepted: Admitted = { ...operation, sequence: ++this.acceptedSequence }
    if (replaceAt >= 0) {
      this.buffered.splice(replaceAt, 1)
    }
    this.queuedBytes = queuedBytes
    this.queuedOperations = queuedOperations
    if (this.target) {
      this.stage(accepted, this.target)
    } else {
      this.buffered.push(accepted)
    }
    this.updateBackpressure()
    return { accepted: true }
  }

  /** One synchronous provider dispatch is indivisible, including work beyond ready-batch caps. */
  private stage(operation: Admitted, bound: StructuredAgentSessionEventTarget): void {
    if (!operation.steps && operation.publicationKey === undefined) {
      this.seal()
      this.handOver(operation, bound)
      return
    }
    this.dispatch.push(operation)
  }

  private seal(): void {
    if (this.target) {
      const operation = this.dispatch.seal(this.target)
      if (operation) {
        this.handOver(operation, this.target)
      }
    }
  }

  private handOver(operation: Admitted, bound: StructuredAgentSessionEventTarget): void {
    this.handedOverSequence = operation.sequence
    const outcome = runStructuredAgentSessionSinkOperation(operation, bound)
    // Observe failure immediately even if earlier writes are still settling.
    const landed = outcome.then(() => undefined, this.fail)
    this.handedOverSettled = Promise.all([this.handedOverSettled, landed]).then(() =>
      this.settle(operation)
    )
  }

  private settle(operation: Admitted): void {
    this.release(operation)
    this.settledSequence = Math.max(this.settledSequence, operation.sequence)
    this.updateBackpressure()
    this.settleWaiters()
  }

  private release(operation: Admitted): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - operation.bytes)
    this.queuedOperations = Math.max(0, this.queuedOperations - (operation.operations ?? 1))
  }

  /** Buffered drops settle only after earlier handed-over writes so barriers cannot overtake them. */
  private dropBuffered(): void {
    const dropped = [...this.dispatch.take(), ...this.buffered.splice(0)]
    for (const operation of dropped) {
      this.release(operation)
    }
    const last = dropped.at(-1)
    if (last) {
      this.handedOverSettled = this.handedOverSettled.then(() => {
        this.settledSequence = Math.max(this.settledSequence, last.sequence)
        this.settleWaiters()
      })
    }
  }

  private setBackpressure(next: boolean): void {
    if (next === this.backpressured) {
      return
    }
    this.backpressured = next
    this.syncReading()
    this.deps.onBackpressureChange?.(next, this.state())
  }

  /** A drain must not resume a stream still held for an epoch replacement. */
  private syncReading(): void {
    const paused = !this.closed && (this.backpressured || this.snapshots.held)
    if (paused === this.readingPaused) {
      return
    }
    this.readingPaused = paused
    if (paused) {
      this.readingControl?.pauseReading()
    } else {
      this.readingControl?.resumeReading()
    }
  }

  private updateBackpressure(): void {
    const next = this.closed
      ? false
      : this.failure !== null ||
        (this.backpressured
          ? this.queuedBytes > this.deps.watermarks.lowQueuedBytes ||
            this.queuedOperations > this.deps.watermarks.lowQueuedOperations
          : this.queuedBytes >= this.deps.watermarks.pauseQueuedBytes ||
            this.queuedOperations >= this.deps.watermarks.pauseQueuedOperations)
    this.setBackpressure(next)
  }

  private barrierResult(): StructuredAgentSessionSinkBarrier {
    return this.failure === null ? { ok: true } : { ok: false, error: this.failure.error }
  }

  private settleWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]
      if (waiter && waiter.through <= this.settledSequence) {
        this.waiters.splice(index, 1)
        waiter.resolve(this.barrierResult())
      }
    }
  }

  private fail = (error: unknown): void => {
    if (this.failure === null) {
      this.failure = { error }
      this.deps.onFailed?.(error)
    }
    this.dropBuffered()
    this.updateBackpressure()
  }
}
