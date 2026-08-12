import {
  relayWriterControlReserve,
  type DispatcherWriterLane,
  type DispatcherWriterSettlement
} from './dispatcher-writer-admission'

export type SinkWriteSettlement = DispatcherWriterSettlement

export type RelayClientWrite = (
  data: Buffer,
  onSettled: (result: SinkWriteSettlement) => void
) => boolean | void

export type RelayClientSinkOptions = {
  waitWriteDrain?: (callback: () => void) => void | (() => void)
  writableLength?: () => number
  writableHighWaterMark?: () => number
  supportsWriteCallback?: boolean
  close?: () => void
}

export class DispatcherWriterSink {
  constructor(
    readonly write: RelayClientWrite,
    private readonly options: RelayClientSinkOptions
  ) {}

  get supportsWriteCallback(): boolean {
    return this.options.supportsWriteCallback === true
  }

  get writableLength(): number {
    const value = this.options.writableLength?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }

  get highWaterMark(): number {
    const value = this.options.writableHighWaterMark?.()
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : Number.POSITIVE_INFINITY
  }

  get producerFrameCapacity(): number {
    if (!Number.isFinite(this.highWaterMark)) {
      return Number.MAX_SAFE_INTEGER
    }
    return Math.max(0, this.highWaterMark - relayWriterControlReserve(this.highWaterMark))
  }

  frameCapacity(lane: DispatcherWriterLane, producerBlocked = false): number {
    if (lane === 'fixed-bulk') {
      return !producerBlocked && this.writableLength === 0 ? Number.MAX_SAFE_INTEGER : 0
    }
    return this.producerFrameCapacity
  }

  registerDrain(callback: () => void): { registered: boolean; remove: () => void } {
    if (!this.options.waitWriteDrain) {
      return { registered: false, remove: () => {} }
    }
    const remove = this.options.waitWriteDrain(callback)
    return {
      registered: true,
      remove: typeof remove === 'function' ? remove : () => {}
    }
  }

  close(): void {
    this.options.close?.()
  }
}
