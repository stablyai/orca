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
import { StructuredAgentSessionFinalTailReservation } from './structured-agent-session-final-tail-reservation'

export type StructuredAgentSessionSinkOperation = {
  sequence: number
  bytes: number
  lifecycleBytes?: number
  lifecycle?: boolean
  finalTail?: true
  /** Only publications coalesce by key; replacing journal writes would reorder them behind later work. */
  publicationKey?: string
  /** Handover synchronously joins the journal queue in submission order. */
  run: (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void
}

type Admitted = StructuredAgentSessionSinkOperation & {
  superseded?: boolean
  releaseFinalTail?: () => void
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
  private lifecycleQueuedBytes = 0
  private lifecycleQueuedOperations = 0
  private backpressured = false
  private acceptedSequence = 0
  private settledSequence = 0
  /** Closing drops only buffered operations after this handover sequence. */
  private handedOverSequence = 0
  private handedOverSettled: Promise<void> = Promise.resolve()
  private readonly buffered: Admitted[] = []
  private readonly waitingPublications = new Map<string, Admitted>()
  private readonly waiters: StructuredAgentSessionDrainWaiter[] = []
  private readonly finalTail = new StructuredAgentSessionFinalTailReservation()

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
    for (const operation of this.buffered.splice(0)) {
      this.handOver(operation, target)
    }
  }

  unbind(): void {
    this.target = null
  }

  close(): void {
    this.closed = true
    this.dropBuffered()
    this.finalTail.close()
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
    const finalTail = operation.finalTail === true
    const lifecycle = !finalTail && (operation.lifecycle ?? options.lifecycle === true)
    const lifecycleBytes = lifecycle ? (operation.lifecycleBytes ?? operation.bytes) : 0
    const nextBytes = this.queuedBytes - (replaced?.bytes ?? 0) + operation.bytes
    const nextOperations = this.queuedOperations + (replaced ? 0 : 1)
    const nextLifecycleBytes =
      this.lifecycleQueuedBytes - (replaced ? lifecycleCost(replaced) : 0) + lifecycleBytes
    const nextLifecycleOperations =
      this.lifecycleQueuedOperations - (replaced?.lifecycle ? 1 : 0) + (lifecycle ? 1 : 0)
    // Bytes pace input; operation counts determine admission refusal.
    const exceedsOrdinary =
      !finalTail && !lifecycle && nextOperations > this.deps.watermarks.maxQueuedOperations
    const exceedsLifecycle =
      lifecycle && nextLifecycleOperations > this.deps.watermarks.maxLifecycleQueuedOperations
    if (exceedsOrdinary || exceedsLifecycle) {
      this.setBackpressure(true)
      return { accepted: false, reason: 'backpressure' }
    }
    const releaseFinalTail =
      finalTail && key === undefined ? this.finalTail.reserve(operation.bytes) : undefined
    if (finalTail && !releaseFinalTail) {
      this.fail(new Error('structured agent-session final tail exceeded its reserved capacity'))
      return { accepted: false, reason: 'failed' }
    }
    const accepted: Admitted = {
      ...operation,
      sequence: ++this.acceptedSequence,
      lifecycle,
      lifecycleBytes,
      releaseFinalTail: releaseFinalTail ?? undefined
    }
    if (replaceAt >= 0) {
      this.buffered.splice(replaceAt, 1)
    } else if (replaced) {
      // Superseded publications still settle in order as no-ops.
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
    this.handedOverSequence = operation.sequence
    const key = operation.publicationKey
    let outcome: Promise<unknown>
    if (key === undefined) {
      outcome = runNow(() => operation.run(bound))
    } else {
      this.waitingPublications.set(key, operation)
      // Publications read in journal order so they cannot overtake prior writes.
      outcome = runNow(() =>
        bound.journal.readInOrder(() => {
          if (this.waitingPublications.get(key) === operation) {
            this.waitingPublications.delete(key)
          }
          return operation.superseded || this.closed || this.failure !== null
            ? undefined
            : operation.run(bound)
        })
      )
    }
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
    operation.releaseFinalTail?.()
    this.queuedBytes = Math.max(0, this.queuedBytes - operation.bytes)
    this.queuedOperations = Math.max(0, this.queuedOperations - 1)
    if (operation.lifecycle) {
      this.lifecycleQueuedBytes = Math.max(0, this.lifecycleQueuedBytes - lifecycleCost(operation))
      this.lifecycleQueuedOperations = Math.max(0, this.lifecycleQueuedOperations - 1)
    }
  }

  /** Buffered drops settle only after earlier handed-over writes so barriers cannot overtake them. */
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

  private fail = (error: unknown): void => {
    if (this.failure === null) {
      this.failure = { error }
      this.deps.onFailed?.(error)
    }
    this.dropBuffered()
    this.finalTail.close()
    this.updateBackpressure()
  }
}

function lifecycleCost(operation: StructuredAgentSessionSinkOperation): number {
  return operation.lifecycle ? (operation.lifecycleBytes ?? operation.bytes) : 0
}

function runNow(run: () => Promise<unknown> | void): Promise<unknown> {
  try {
    return Promise.resolve(run())
  } catch (error) {
    return Promise.reject(error)
  }
}
