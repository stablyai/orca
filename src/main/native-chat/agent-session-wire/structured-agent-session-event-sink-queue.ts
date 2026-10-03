import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventTarget,
  StructuredAgentSessionLinkageJournal,
  StructuredAgentSessionReadingControl,
  StructuredAgentSessionSinkAdmission,
  StructuredAgentSessionSinkBarrier,
  StructuredAgentSessionSinkState,
  StructuredAgentSessionSinkWatermarks
} from './structured-agent-session-event-sink'

export type StructuredAgentSessionSinkOperation = {
  sequence: number
  bytes: number
  /** Lifecycle rows use their own bounded reservation budget. */
  lifecycleBytes?: number
  lifecycle?: boolean
  /** Marks a publication, which writes no row: it runs at handover, or at its place in the
   *  journal's queue while writes wait there, and one still waiting with the same key is replaced
   *  by the next. Journal writes never coalesce:
   *  replacing one would move it behind whatever was issued after it. */
  publicationKey?: string
  /** Called at handover, so a journal write it issues takes its place in the chat's one write queue
   *  in the same tick it was submitted. */
  run: (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void
}

type Admitted = StructuredAgentSessionSinkOperation & { superseded?: boolean }

export type StructuredAgentSessionDrainWaiter = {
  through: number
  resolve: (result: StructuredAgentSessionSinkBarrier) => void
}

/**
 * Admission and backpressure for one provider stream's writes. It holds nothing once bound: each
 * operation is handed to the journal as it is submitted, so a streamed row and a host write are
 * ordered by when they were issued, in the journal's one queue. Only while no journal is bound do
 * operations wait here, in arrival order, and bind hands them over before it returns. Pressure
 * counts what was admitted and has not yet settled, wherever it waits.
 */
export class StructuredAgentSessionSinkQueue {
  private readingControl: StructuredAgentSessionReadingControl | undefined
  private target: StructuredAgentSessionEventTarget | null = null
  private closed = false
  private failure: { error: unknown } | null = null
  private queuedBytes = 0
  private queuedOperations = 0
  private lifecycleQueuedBytes = 0
  private lifecycleQueuedOperations = 0
  private backpressured = false
  private acceptedSequence = 0
  private settledSequence = 0
  /** Settles once every operation handed over so far has, in handover order. */
  private handedOverSettled: Promise<void> = Promise.resolve()
  private readonly buffered: Admitted[] = []
  private readonly waitingPublications = new Map<string, Admitted>()
  private readonly waiters: StructuredAgentSessionDrainWaiter[] = []

  constructor(
    private readonly deps: {
      watermarks: StructuredAgentSessionSinkWatermarks
      /** The queue just failed for good; it accepts and runs nothing more. */
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

  journalStopDecidesTurn = (turnId: string, endedAt: number, openedBy?: string): boolean =>
    this.target?.journal.stopMarks.personStopDecides(turnId, endedAt, openedBy) ?? false

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
    for (const operation of this.buffered.splice(0)) {
      this.handOver(operation, target)
    }
  }

  unbind(): void {
    this.target = null
  }

  /** Operations already handed over are the journal's and still land; only buffered ones drop. */
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

  submit(
    operation: Omit<StructuredAgentSessionSinkOperation, 'sequence'>,
    options: StructuredAgentSessionAppendOptions = {}
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
    const replaced =
      replaceAt >= 0
        ? this.buffered[replaceAt]
        : key === undefined
          ? undefined
          : this.waitingPublications.get(key)
    const lifecycle = operation.lifecycle ?? options.lifecycle === true
    const lifecycleBytes = lifecycle ? (operation.lifecycleBytes ?? operation.bytes) : 0
    const nextBytes = this.queuedBytes - (replaced?.bytes ?? 0) + operation.bytes
    const nextOperations = this.queuedOperations + (replaced ? 0 : 1)
    const nextLifecycleBytes =
      this.lifecycleQueuedBytes - (replaced ? lifecycleCost(replaced) : 0) + lifecycleBytes
    const nextLifecycleOperations =
      this.lifecycleQueuedOperations - (replaced?.lifecycle ? 1 : 0) + (lifecycle ? 1 : 0)
    const exceedsOrdinary =
      !lifecycle &&
      (nextBytes > this.deps.watermarks.maxQueuedBytes ||
        nextOperations > this.deps.watermarks.maxQueuedOperations)
    const exceedsLifecycle =
      lifecycle &&
      (nextLifecycleBytes > this.deps.watermarks.maxLifecycleQueuedBytes ||
        nextLifecycleOperations > this.deps.watermarks.maxLifecycleQueuedOperations)
    if (exceedsOrdinary || exceedsLifecycle) {
      this.setBackpressure(true)
      return { accepted: false, reason: 'backpressure' }
    }
    const accepted: Admitted = {
      ...operation,
      sequence: ++this.acceptedSequence,
      lifecycle,
      lifecycleBytes
    }
    if (replaceAt >= 0) {
      this.buffered.splice(replaceAt, 1)
    } else if (replaced) {
      // Its turn still comes, and settles as nothing: the publication after it covers it.
      replaced.superseded = true
    }
    this.queuedBytes = nextBytes
    this.queuedOperations = nextOperations
    this.lifecycleQueuedBytes = nextLifecycleBytes
    this.lifecycleQueuedOperations = nextLifecycleOperations
    if (this.target) {
      this.handOver(accepted, this.target)
    } else {
      this.buffered.push(accepted)
    }
    this.updateBackpressure()
    return { accepted: true }
  }

  private handOver(operation: Admitted, bound: StructuredAgentSessionEventTarget): void {
    const earlier = this.handedOverSettled
    const key = operation.publicationKey
    let outcome: Promise<unknown>
    if (key === undefined) {
      outcome = runNow(() => operation.run(bound))
    } else {
      this.waitingPublications.set(key, operation)
      // At handover, unless writes still wait behind an owed import; then at its place in line, so
      // it never announces ahead of the writes issued before it.
      outcome = runNow(() =>
        bound.journal.readInOrder(() => {
          if (this.waitingPublications.get(key) === operation) {
            this.waitingPublications.delete(key)
          }
          // A publication writes no row, so a closed or failed sink has nothing left to announce.
          return operation.superseded || this.closed || this.failure !== null
            ? undefined
            : operation.run(bound)
        })
      )
    }
    // Handled at once: a write can fail while an earlier one is still landing.
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
    if (operation.lifecycle) {
      this.lifecycleQueuedBytes = Math.max(0, this.lifecycleQueuedBytes - lifecycleCost(operation))
      this.lifecycleQueuedOperations = Math.max(0, this.lifecycleQueuedOperations - 1)
    }
  }

  /** Buffered operations never reached a journal. They count as settled once everything handed
   *  over before them has, so a barrier never resolves ahead of a write still landing. */
  private dropBuffered(): void {
    const dropped = this.buffered.splice(0)
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
    if (next) {
      this.readingControl?.pauseReading()
    } else {
      this.readingControl?.resumeReading()
    }
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

  /** Writes handed over before this runs still land; nothing submitted after it is admitted. */
  private fail = (error: unknown): void => {
    if (this.failure === null) {
      this.failure = { error }
      this.deps.onFailed?.(error)
    }
    this.dropBuffered()
    this.updateBackpressure()
  }
}

function lifecycleCost(operation: StructuredAgentSessionSinkOperation): number {
  return operation.lifecycle ? (operation.lifecycleBytes ?? operation.bytes) : 0
}

/** A synchronous throw settles as a rejection, like any other failed write. */
function runNow(run: () => Promise<unknown> | void): Promise<unknown> {
  try {
    return Promise.resolve(run())
  } catch (error) {
    return Promise.reject(error)
  }
}
