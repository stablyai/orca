import {
  DEFAULT_PRODUCER_QUEUE_MAX_BYTES,
  DispatcherWriterAdmission,
  onceDispatcherWriterSettlement,
  type DispatcherWriterEntry,
  type DispatcherWriterLane
} from './dispatcher-writer-admission'
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
  private saturated = false
  private drainArmed = false
  private removeDrainListener: (() => void) | null = null
  private livenessBypassOutstanding = false
  private pumping = false
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
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    if (this.closed) {
      onSettled({ ok: false, error: new Error('Relay writer is closed') })
      return false
    }
    const entry: DispatcherWriterEntry = {
      lane,
      encode,
      estimatedBytes,
      onSettled: onceDispatcherWriterSettlement(onSettled),
      settled: false
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
    this.drainArmed = false
    this.clearDrainListener()
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
      (entry) => this.canWriteControl(entry),
      (entry) => this.canWriteProducer(entry)
    )
  }

  private canWriteControl(entry: DispatcherWriterEntry): boolean {
    const highWaterMark = this.sink.highWaterMark
    if (!Number.isFinite(highWaterMark)) {
      return true
    }
    const writableLength = this.sink.writableLength
    return writableLength + entry.estimatedBytes <= highWaterMark || writableLength === 0
  }

  private canWriteProducer(entry: DispatcherWriterEntry): boolean {
    const highWaterMark = this.sink.highWaterMark
    if (!Number.isFinite(highWaterMark)) {
      return true
    }
    return (
      this.sink.writableLength + entry.estimatedBytes <= this.sink.producerFrameCapacity ||
      this.sink.writableLength === 0
    )
  }

  private writeEntry(entry: DispatcherWriterEntry): void {
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
    if (this.drainArmed) {
      return
    }
    this.drainArmed = true
    try {
      const registration = this.sink.registerDrain(() => this.handleDrain())
      if (!registration.registered) {
        this.drainArmed = false
      } else if (this.drainArmed) {
        this.removeDrainListener = registration.remove
      } else {
        registration.remove()
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleDrain(): void {
    if (this.closed || !this.drainArmed) {
      return
    }
    this.drainArmed = false
    this.clearDrainListener()
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

  private clearDrainListener(): void {
    const remove = this.removeDrainListener
    this.removeDrainListener = null
    remove?.()
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
