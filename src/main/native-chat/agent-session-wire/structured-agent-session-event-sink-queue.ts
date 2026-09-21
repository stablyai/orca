import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventTarget,
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
  coalescingKey?: string
  run: (target: StructuredAgentSessionEventTarget) => Promise<unknown> | void
}

export type StructuredAgentSessionDrainWaiter = {
  through: number
  resolve: (result: StructuredAgentSessionSinkBarrier) => void
}

export class StructuredAgentSessionSinkQueue {
  private readingControl: StructuredAgentSessionReadingControl | undefined
  private target: StructuredAgentSessionEventTarget | null = null
  private closed = false
  private failure: { error: unknown } | null = null
  private running = false
  private queuedBytes = 0
  private queuedOperations = 0
  private lifecycleQueuedBytes = 0
  private lifecycleQueuedOperations = 0
  private backpressured = false
  private acceptedSequence = 0
  private settledSequence = 0
  private readonly queue: StructuredAgentSessionSinkOperation[] = []
  private readonly waiters: StructuredAgentSessionDrainWaiter[] = []

  constructor(
    private readonly deps: {
      watermarks: StructuredAgentSessionSinkWatermarks
      onError?: (error: unknown) => void
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
    if (!this.closed) {
      this.target = target
      this.pump()
    }
  }

  unbind(): void {
    this.target = null
  }

  close(): void {
    this.closed = true
    this.queue.length = 0
    this.queuedBytes = 0
    this.queuedOperations = 0
    this.lifecycleQueuedBytes = 0
    this.lifecycleQueuedOperations = 0
    this.settledSequence = this.acceptedSequence
    this.updateBackpressure()
    this.settleWaiters()
  }

  barrier = (): Promise<StructuredAgentSessionSinkBarrier> => {
    const through = this.acceptedSequence
    if (this.settledSequence >= through) {
      return Promise.resolve(
        this.failure === null ? { ok: true } : { ok: false, error: this.failure.error }
      )
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
    const sequence = ++this.acceptedSequence
    const key = options.coalescingKey ?? operation.coalescingKey
    const replaceAt = key ? this.queue.findIndex((queued) => queued.coalescingKey === key) : -1
    const replaced = replaceAt >= 0 ? this.queue[replaceAt] : undefined
    const lifecycle = operation.lifecycle ?? options.lifecycle === true
    const lifecycleBytes = lifecycle ? (operation.lifecycleBytes ?? operation.bytes) : 0
    const nextBytes = this.queuedBytes - (replaced?.bytes ?? 0) + operation.bytes
    const nextOperations = this.queuedOperations + (replaced ? 0 : 1)
    const nextLifecycleBytes =
      this.lifecycleQueuedBytes -
      (replaced?.lifecycle ? (replaced.lifecycleBytes ?? replaced.bytes) : 0) +
      lifecycleBytes
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
      this.acceptedSequence -= 1
      this.setBackpressure(true)
      return { accepted: false, reason: 'backpressure' }
    }
    const accepted = {
      ...operation,
      sequence,
      lifecycle,
      lifecycleBytes,
      ...(key ? { coalescingKey: key } : {})
    }
    if (replaced) {
      this.queue.splice(replaceAt, 1)
    }
    this.queue.push(accepted)
    this.queuedBytes = nextBytes
    this.queuedOperations = nextOperations
    this.lifecycleQueuedBytes = nextLifecycleBytes
    this.lifecycleQueuedOperations = nextLifecycleOperations
    this.updateBackpressure()
    this.pump()
    return { accepted: true }
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

  private settleWaiters(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]
      if (waiter && waiter.through <= this.settledSequence) {
        this.waiters.splice(index, 1)
        waiter.resolve(
          this.failure === null ? { ok: true } : { ok: false, error: this.failure.error }
        )
      }
    }
  }

  private fail = (error: unknown): void => {
    if (this.failure === null) {
      this.failure = { error }
      this.deps.onError?.(error)
    }
    this.queue.length = 0
    this.queuedBytes = 0
    this.queuedOperations = 0
    this.lifecycleQueuedBytes = 0
    this.lifecycleQueuedOperations = 0
    this.settledSequence = this.acceptedSequence
    this.updateBackpressure()
    this.settleWaiters()
  }

  private pump(): void {
    if (this.running || !this.target || this.closed || this.failure !== null) {
      return
    }
    const operation = this.queue.shift()
    if (!operation) {
      return
    }
    this.running = true
    const bound = this.target
    void Promise.resolve(operation.run(bound))
      .catch(this.fail)
      .finally(() => {
        this.running = false
        this.queuedBytes = Math.max(0, this.queuedBytes - operation.bytes)
        this.queuedOperations = Math.max(0, this.queuedOperations - 1)
        if (operation.lifecycle) {
          this.lifecycleQueuedBytes = Math.max(
            0,
            this.lifecycleQueuedBytes - (operation.lifecycleBytes ?? operation.bytes)
          )
          this.lifecycleQueuedOperations = Math.max(0, this.lifecycleQueuedOperations - 1)
        }
        this.settledSequence = Math.max(this.settledSequence, operation.sequence)
        this.updateBackpressure()
        this.settleWaiters()
        this.pump()
      })
  }
}
