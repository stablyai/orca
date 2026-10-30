import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventTarget,
  StructuredAgentSessionHistoryJournal,
  StructuredAgentSessionLinkageJournal,
  StructuredAgentSessionReadingControl,
  StructuredAgentSessionSinkAdmission,
  StructuredAgentSessionSinkBarrier,
  StructuredAgentSessionSinkState,
  StructuredAgentSessionSinkWatermarks
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from './structured-agent-session-transition'

export type StructuredAgentSessionSinkOperation = {
  sequence: number
  bytes: number
  lifecycle?: boolean
  /** Only publications coalesce by key; replacing journal writes would reorder them behind later work. */
  publicationKey?: string
  /** Handover synchronously joins the journal queue in submission order. */
  run: (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void
}

type Admitted = StructuredAgentSessionSinkOperation & {
  superseded?: boolean
}

export type StructuredAgentSessionDrainWaiter = {
  through: number
  resolve: (result: StructuredAgentSessionSinkBarrier) => void
}

/** Buffer only before bind, then hand writes directly to the journal in issuance order.
 * Pressure counts all admitted unsettled operations, wherever they wait. */
export class StructuredAgentSessionSinkQueue {
  private readingControl: StructuredAgentSessionReadingControl | undefined
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
  private readonly buffered = new Map<number, Admitted>()
  private readonly waitingPublications = new Map<string, Admitted>()
  private readonly waiters: StructuredAgentSessionDrainWaiter[] = []

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
  }

  state = (): StructuredAgentSessionSinkState => ({
    queuedBytes: this.queuedBytes,
    queuedOperations: this.queuedOperations,
    backpressured: this.backpressured,
    failed: this.failure !== null
  })

  journalEpoch = (): string | null => this.target?.journal.epoch ?? null

  journalLinkage = (): StructuredAgentSessionLinkageJournal | null => this.target?.journal ?? null

  journalHistory = (): StructuredAgentSessionHistoryJournal | null => this.target?.journal ?? null

  journalItems = (): StructuredAgentSessionTransitionJournal | null => this.target?.journal ?? null

  journalStopDecidesTurn = (turnId: string, endedAt: number): boolean =>
    this.target?.journal.stopMarks.personStopDecides(turnId, endedAt) ?? false

  bindReadingControl(control: StructuredAgentSessionReadingControl): () => void {
    this.readingControl = control
    if (this.backpressured) {
      control.pauseReading()
    }
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
    this.target = target
    for (const [sequence, operation] of this.buffered) {
      this.buffered.delete(sequence)
      this.handOver(operation, target)
    }
  }

  unbind(): void {
    this.target = null
  }

  close(): void {
    this.closed = true
    this.dropBuffered()
    this.updateBackpressure()
  }

  barrier = (): Promise<StructuredAgentSessionSinkBarrier> => {
    const through = this.acceptedSequence
    if (this.settledSequence >= through) {
      return Promise.resolve(this.barrierResult())
    }
    return new Promise((resolve) => this.waiters.push({ through, resolve }))
  }

  /** Unlike barrier, report close-dropped admitted writes as not landed. */
  written = async (): Promise<StructuredAgentSessionSinkBarrier> => {
    const through = this.acceptedSequence
    const settled = await this.barrier()
    return settled.ok && this.handedOverSequence < through
      ? { ok: false, error: new Error('the sink closed before its writes landed') }
      : settled
  }

  submit(
    operation: Omit<StructuredAgentSessionSinkOperation, 'sequence'>,
    _options: StructuredAgentSessionAppendOptions = {}
  ): StructuredAgentSessionSinkAdmission {
    if (this.closed) {
      return { accepted: false, reason: 'closed' }
    }
    if (this.failure !== null) {
      return { accepted: false, reason: 'failed' }
    }
    const key = operation.publicationKey
    const replaced = key === undefined ? undefined : this.waitingPublications.get(key)
    const nextBytes = this.queuedBytes - (replaced?.bytes ?? 0) + operation.bytes
    const nextOperations = this.queuedOperations + (replaced ? 0 : 1)
    // Received content always joins the journal; pressure only paces future input.
    const accepted: Admitted = {
      ...operation,
      sequence: ++this.acceptedSequence
    }
    if (replaced && !this.buffered.delete(replaced.sequence)) {
      // Superseded publications still settle in order as no-ops.
      replaced.superseded = true
    }
    if (key !== undefined) {
      this.waitingPublications.set(key, accepted)
    }
    this.queuedBytes = nextBytes
    this.queuedOperations = nextOperations
    void (this.target
      ? this.handOver(accepted, this.target)
      : this.buffered.set(accepted.sequence, accepted))
    this.updateBackpressure()
    return { accepted: true }
  }

  private handOver(operation: Admitted, bound: StructuredAgentSessionEventTarget): void {
    const earlier = this.handedOverSettled
    this.handedOverSequence = operation.sequence
    const key = operation.publicationKey
    let outcome: Promise<unknown>
    void (key === undefined
      ? (outcome = runNow(() => operation.run(bound)))
      : (outcome = runNow(() =>
          bound.journal.readInOrder(() => {
            if (this.waitingPublications.get(key) === operation) {
              this.waitingPublications.delete(key)
            }
            return operation.superseded || this.closed || this.failure !== null
              ? undefined
              : operation.run(bound)
          })
        )))
    // Observe failure immediately even if earlier writes are still settling.
    const landed = outcome.then(() => undefined, this.fail)
    this.handedOverSettled = Promise.all([earlier, landed]).then(() => this.settle(operation))
  }

  private settle(operation: Admitted): void {
    if (!operation.superseded) {
      this.release(operation)
    }
    this.settledSequence = Math.max(this.settledSequence, operation.sequence)
    this.updateBackpressure()
    this.settleWaiters()
  }

  private release(operation: Admitted): void {
    this.queuedBytes = Math.max(0, this.queuedBytes - operation.bytes)
    this.queuedOperations = Math.max(0, this.queuedOperations - 1)
  }

  /** Buffered drops settle only after earlier handed-over writes so barriers cannot overtake them. */
  private dropBuffered(): void {
    let last: Admitted | undefined
    for (const operation of this.buffered.values()) {
      this.release(operation)
      const key = operation.publicationKey
      if (key !== undefined && this.waitingPublications.get(key) === operation) {
        this.waitingPublications.delete(key)
      }
      last = operation
    }
    this.buffered.clear()
    const droppedThrough = last?.sequence
    if (droppedThrough !== undefined) {
      this.handedOverSettled = this.handedOverSettled.then(() => {
        this.settledSequence = Math.max(this.settledSequence, droppedThrough)
        this.settleWaiters()
      })
    }
  }

  private setBackpressure(next: boolean): void {
    if (next === this.backpressured) {
      return
    }
    this.backpressured = next
    void (next ? this.readingControl?.pauseReading() : this.readingControl?.resumeReading())
    this.deps.onBackpressureChange?.(next, this.state())
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

function runNow(run: () => Promise<unknown> | void): Promise<unknown> {
  try {
    return Promise.resolve(run())
  } catch (error) {
    return Promise.reject(error)
  }
}
