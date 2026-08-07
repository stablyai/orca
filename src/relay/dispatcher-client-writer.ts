import {
  DEFAULT_PRODUCER_QUEUE_MAX_BYTES,
  DispatcherWriterAdmission,
  onceDispatcherWriterSettlement,
  type DispatcherWriterEntry,
  type DispatcherWriterLane
} from './dispatcher-writer-admission'
import { DispatcherWriterDrainArm } from './dispatcher-writer-drain-arm'
import { DispatcherWriterLaneScheduler } from './dispatcher-writer-lane-scheduler'
import {
  DispatcherWriterSink,
  type RelayClientSinkOptions,
  type RelayClientWrite,
  type SinkWriteSettlement
} from './dispatcher-writer-sink'

export {
  DEFAULT_PRODUCER_QUEUE_MAX_BYTES,
  DISPATCHER_CONTROL_QUEUE_MAX_BYTES,
  relayWriterControlReserve
} from './dispatcher-writer-admission'
export type {
  RelayClientSinkOptions,
  RelayClientWrite,
  SinkWriteSettlement
} from './dispatcher-writer-sink'
export type { DispatcherWriterLane } from './dispatcher-writer-admission'

export class DispatcherClientWriter {
  private readonly admission: DispatcherWriterAdmission
  private readonly sink: DispatcherWriterSink
  private readonly laneScheduler = new DispatcherWriterLaneScheduler()
  private readonly inFlight = new Set<DispatcherWriterEntry>()
  private readonly settleOnDrain = new Set<DispatcherWriterEntry>()
  private readonly capacityListeners = new Set<() => void>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly drain = new DispatcherWriterDrainArm()
  private saturated = false
  private livenessBypassOutstanding = false
  private pumping = false
  private retiredCapacity = false
  private closed = false
  private closeNotified = false

  constructor(
    write: RelayClientWrite,
    sinkOptions: RelayClientSinkOptions = {},
    private readonly onClosed: (error: Error) => void = () => {},
    producerQueueMaxBytes = DEFAULT_PRODUCER_QUEUE_MAX_BYTES
  ) {
    this.admission = new DispatcherWriterAdmission(producerQueueMaxBytes)
    this.sink = new DispatcherWriterSink(write, sinkOptions)
  }

  get retainedProducerBytes(): number {
    return this.admission.retainedProducerBytes
  }

  get producerFrameCapacity(): number {
    return this.sink.producerFrameCapacity
  }

  canEnqueueControl(bytes: number): boolean {
    return !this.closed && this.admission.canAdmitControl(bytes)
  }

  get fixedFrameCapacity(): number {
    return this.sink.frameCapacity('fixed-bulk', this.saturated)
  }

  canEnqueueProducer(bytes: number): boolean {
    return !this.closed && this.admission.canAdmitProducer(bytes, this.producerFrameCapacity)
  }

  onCapacity(listener: () => void): () => void {
    this.capacityListeners.add(listener)
    return () => this.capacityListeners.delete(listener)
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  enqueue(
    lane: DispatcherWriterLane,
    encode: () => Buffer,
    estimatedBytes: number,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    overflowIsNonFatal = false,
    isStillAdmitted?: () => boolean
  ): boolean {
    if (this.closed) {
      onSettled({ ok: false, error: new Error('Relay writer is closed') })
      return false
    }
    const entry: DispatcherWriterEntry = {
      lane,
      encode,
      isStillAdmitted,
      estimatedBytes,
      onSettled: onceDispatcherWriterSettlement(onSettled),
      settled: false,
      overflowIsNonFatal
    }
    const admission = this.admission.admit(entry, this.sink.frameCapacity(lane, this.saturated))
    if (!admission.accepted) {
      if (admission.error) {
        entry.onSettled({ ok: false, error: admission.error })
        this.close(admission.error)
      } else if (lane === 'liveness') {
        entry.onSettled({ ok: true })
      }
      return false
    }
    if (admission.replaced) {
      admission.replaced.settled = true
      admission.replaced.onSettled({ ok: true })
    }
    this.pump()
    return true
  }

  close(error = new Error('Relay writer closed')): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.saturated = false
    this.drain.disarm()
    for (const entry of this.admission.takeQueued()) {
      this.releaseEntry(entry, { ok: false, error })
    }
    for (const entry of Array.from(this.inFlight)) {
      this.releaseEntry(entry, { ok: false, error })
    }
    this.settleOnDrain.clear()
    this.capacityListeners.clear()
    this.notifyIdle()
    try {
      this.sink.close()
    } catch {
      // The writer state is already closed.
    }
    if (!this.closeNotified) {
      this.closeNotified = true
      this.onClosed(error)
    }
  }

  private pump(): void {
    if (this.pumping || this.closed) {
      return
    }
    this.pumping = true
    try {
      while (!this.closed) {
        const entry = this.selectNext()
        if (!entry) {
          break
        }
        this.writeEntry(entry)
        if (this.saturated && entry.lane !== 'liveness') {
          break
        }
      }
    } finally {
      this.pumping = false
    }
    // Why deferred: retiring a deep queue drops every entry in one pass, and notifying per drop
    // fans out to each listener O(queue) times for capacity that only changed once.
    if (this.retiredCapacity && !this.closed) {
      this.retiredCapacity = false
      this.notifyCapacity()
    }
  }

  private selectNext(): DispatcherWriterEntry | undefined {
    if (this.saturated) {
      if (this.livenessBypassOutstanding) {
        return undefined
      }
      const bypass = this.admission.shift('liveness')
      if (bypass) {
        this.livenessBypassOutstanding = true
      }
      return bypass
    }
    return this.laneScheduler.select(
      this.admission,
      (entry) => this.canWrite(entry, this.sink.highWaterMark),
      (entry) => this.canWrite(entry, this.sink.producerFrameCapacity)
    )
  }

  // Why: a zero-length writable always takes one frame, else a single oversized frame could never drain.
  private canWrite(entry: DispatcherWriterEntry, capacity: number): boolean {
    if (!Number.isFinite(this.sink.highWaterMark)) {
      return true
    }
    const writableLength = this.sink.writableLength
    return writableLength + entry.estimatedBytes <= capacity || writableLength === 0
  }

  private writeEntry(entry: DispatcherWriterEntry): void {
    if (entry.isStillAdmitted && !entry.isStillAdmitted()) {
      this.releaseEntry(entry, { ok: false, error: new Error('PTY publication retired') })
      this.retiredCapacity = true
      return
    }
    this.laneScheduler.recordWrite(entry.lane)
    this.inFlight.add(entry)
    let callbackResult: SinkWriteSettlement | undefined
    let writeReturned = false
    const onWriteSettled = (result: SinkWriteSettlement): void => {
      if (!writeReturned) {
        callbackResult = result
        return
      }
      this.handleWriteSettlement(entry, result)
    }
    try {
      const accepted = this.sink.write(entry.encode(), onWriteSettled)
      writeReturned = true
      if (accepted === false) {
        this.saturated = true
        if (!this.sink.supportsWriteCallback) {
          this.settleOnDrain.add(entry)
        }
        this.armDrain()
      } else if (!this.sink.supportsWriteCallback) {
        this.handleWriteSettlement(entry, { ok: true })
      }
      if (callbackResult) {
        this.handleWriteSettlement(entry, callbackResult)
      }
    } catch (error) {
      writeReturned = true
      this.handleWriteSettlement(entry, {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error))
      })
    }
  }

  private handleWriteSettlement(entry: DispatcherWriterEntry, result: SinkWriteSettlement): void {
    if (!result.ok) {
      this.releaseEntry(entry, result)
      this.close(result.error)
      return
    }
    this.releaseEntry(entry, result)
    if (entry.lane === 'liveness') {
      this.livenessBypassOutstanding = false
    }
    this.notifyCapacity()
    this.pump()
  }

  private armDrain(): void {
    try {
      this.drain.arm(
        (onDrain) => this.sink.registerDrain(onDrain),
        () => this.handleDrain()
      )
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleDrain(): void {
    if (this.closed || !this.drain.isArmed) {
      return
    }
    this.drain.disarm()
    this.saturated = false
    this.livenessBypassOutstanding = false
    for (const entry of Array.from(this.settleOnDrain)) {
      this.settleOnDrain.delete(entry)
      this.releaseEntry(entry, { ok: true })
    }
    this.notifyCapacity()
    this.pump()
  }

  private releaseEntry(entry: DispatcherWriterEntry, result: SinkWriteSettlement): void {
    if (entry.settled) {
      return
    }
    entry.settled = true
    this.inFlight.delete(entry)
    this.settleOnDrain.delete(entry)
    this.admission.release(entry)
    entry.onSettled(result)
    this.notifyIdle()
  }

  private notifyCapacity(): void {
    for (const listener of this.capacityListeners) {
      listener()
    }
  }

  private isIdle = (): boolean => this.inFlight.size === 0 && this.admission.queuedEntries === 0

  private notifyIdle(): void {
    if (!this.isIdle()) {
      return
    }
    for (const resolve of Array.from(this.idleWaiters)) {
      this.idleWaiters.delete(resolve)
      resolve()
    }
  }
}
