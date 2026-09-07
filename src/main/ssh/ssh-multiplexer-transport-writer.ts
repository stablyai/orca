import { HEADER_LENGTH, MAX_MESSAGE_SIZE } from './relay-protocol'
import { SshMultiplexerWriterLaneScheduler } from './ssh-multiplexer-writer-lane-scheduler'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteAmbiguityReason,
  type WriteRefusalReason,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

/** All the socket itself can prove: it took the buffer, or the attempt failed. */
export type MultiplexerTransportWriteResult = { ok: true } | { ok: false; error: Error }

/**
 * A `WriteSettlement` refined with the transport error the writer needs to fail the session.
 * Only this writer knows whether an entry was still queued or already handed to the
 * transport, so it is the boundary that mints `refused` versus `unverifiable`.
 */
export type MultiplexerWriteSettlement =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; reason: WriteRefusalReason; error: Error }
  | {
      outcome: 'unverifiable'
      reason: WriteAmbiguityReason
      bytesHandedToTransport: true
      error: Error
    }

const ACCEPTED: MultiplexerWriteSettlement = { outcome: 'accepted' }

function transportRefusal(reason: WriteRefusalReason, error: Error): MultiplexerWriteSettlement {
  return { outcome: 'refused', reason, error }
}

/** Drops the transport error so callers carry exactly the fields `WriteSettlement` declares. */
export function toWriteSettlement(result: MultiplexerWriteSettlement): WriteSettlement {
  if (result.outcome === 'accepted') {
    return WRITE_ACCEPTED
  }
  return result.outcome === 'refused'
    ? writeRefused(result.reason)
    : writeUnverifiable(result.reason, result.bytesHandedToTransport)
}

export type MultiplexerTransport = {
  write: (
    data: Buffer,
    onSettled?: (result: MultiplexerTransportWriteResult) => void
  ) => boolean | void
  onData: (cb: (data: Buffer) => void) => void
  onClose: (cb: () => void) => void
  onDrain?: (cb: () => void) => void | (() => void)
  supportsWriteSettlement?: boolean
  pauseReads?: () => void
  resumeReads?: () => void
  close?: () => void
}

export type MultiplexerWriterLane = 'ordinary' | 'control' | 'liveness'

type WriterEntry = {
  data: Buffer
  lane: MultiplexerWriterLane
  onSettled: (result: MultiplexerWriteSettlement) => void
  settled: boolean
}

export const MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES = 2 * 1024 * 1024
export const MULTIPLEXER_CONTROL_RESERVE_BYTES = MAX_MESSAGE_SIZE + HEADER_LENGTH
const ORDINARY_QUEUE_MAX_FRAMES = 2048
const CONTROL_QUEUE_MAX_FRAMES = 512

function onceSettlement(
  callback: (result: MultiplexerWriteSettlement) => void
): (result: MultiplexerWriteSettlement) => void {
  let settled = false
  return (result) => {
    if (settled) {
      return
    }
    settled = true
    callback(result)
  }
}

export class SshMultiplexerTransportWriter {
  private readonly scheduler = new SshMultiplexerWriterLaneScheduler<WriterEntry>()
  private readonly inFlight = new Set<WriterEntry>()
  private readonly settleOnDrain = new Set<WriterEntry>()
  private ordinaryBytes = 0
  private controlBytes = 0
  private ordinaryFrames = 0
  private controlFrames = 0
  private saturated = false
  private writing = false
  private drainObservedDuringWrite = false
  private pumping = false
  private closed = false
  private livenessOutstanding = false
  private removeDrainListener: (() => void) | null = null

  constructor(
    private readonly transport: MultiplexerTransport,
    private readonly onFailure: (error: Error) => void,
    private readonly onSaturationChange: (saturated: boolean) => void = () => {}
  ) {
    if (transport.onDrain) {
      const remove = transport.onDrain(() => this.handleDrain())
      this.removeDrainListener = typeof remove === 'function' ? remove : null
    }
  }

  enqueue(
    data: Buffer,
    lane: MultiplexerWriterLane,
    onSettled: (result: MultiplexerWriteSettlement) => void = () => {}
  ): boolean {
    const settle = onceSettlement(onSettled)
    if (this.closed) {
      settle(transportRefusal('transport_disposed', new Error('Multiplexer writer is closed')))
      return false
    }
    if (lane === 'liveness' && this.livenessOutstanding) {
      return false
    }
    const admissionError = this.admissionError(data.length, lane)
    if (admissionError) {
      settle(transportRefusal('transport_queue_full', admissionError))
      this.fail(admissionError)
      return false
    }
    const entry = { data, lane, onSettled: settle, settled: false }
    this.retain(entry)
    if (lane === 'liveness' && this.saturated) {
      this.writeEntry(entry)
    } else {
      this.scheduler.enqueue(entry, lane)
      this.pump()
    }
    return true
  }

  dispose(error = new Error('Multiplexer writer disposed')): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.saturated = false
    this.removeDrainListener?.()
    this.removeDrainListener = null
    for (const entry of this.scheduler.clear()) {
      this.release(entry, transportRefusal('transport_rejected_before_handoff', error))
    }
    for (const entry of Array.from(this.inFlight)) {
      this.release(entry, transportRefusal('transport_rejected_before_handoff', error))
    }
    this.settleOnDrain.clear()
  }

  private admissionError(bytes: number, lane: MultiplexerWriterLane): Error | null {
    const byteLimit =
      lane === 'ordinary' ? MULTIPLEXER_ORDINARY_QUEUE_MAX_BYTES : MULTIPLEXER_CONTROL_RESERVE_BYTES
    const retainedBytes = lane === 'ordinary' ? this.ordinaryBytes : this.controlBytes
    const frameLimit = lane === 'ordinary' ? ORDINARY_QUEUE_MAX_FRAMES : CONTROL_QUEUE_MAX_FRAMES
    const retainedFrames = lane === 'ordinary' ? this.ordinaryFrames : this.controlFrames
    if (retainedBytes + bytes <= byteLimit && retainedFrames < frameLimit) {
      return null
    }
    return new Error(`Multiplexer ${lane} write queue exceeded its bounded capacity`)
  }

  private pump(): void {
    if (this.pumping || this.closed || this.saturated) {
      return
    }
    this.pumping = true
    try {
      while (!this.closed && !this.saturated) {
        const entry = this.scheduler.select()
        if (!entry) {
          return
        }
        this.writeEntry(entry)
      }
    } finally {
      this.pumping = false
    }
  }

  private writeEntry(entry: WriterEntry): void {
    this.inFlight.add(entry)
    let callbackResult: MultiplexerWriteSettlement | undefined
    let writeReturned = false
    const onWriteSettled = (result: MultiplexerTransportWriteResult): void => {
      const settlement = result.ok
        ? ACCEPTED
        : transportRefusal('transport_rejected_before_handoff', result.error)
      if (!writeReturned) {
        callbackResult = settlement
        return
      }
      this.handleWriteSettlement(entry, settlement)
    }
    try {
      this.writing = true
      this.drainObservedDuringWrite = false
      const accepted = this.transport.write(entry.data, onWriteSettled)
      this.writing = false
      writeReturned = true
      if (accepted === false) {
        if (!this.transport.onDrain) {
          throw new Error('Multiplexer transport returned write(false) without drain support')
        }
        this.setSaturated(!this.drainObservedDuringWrite)
        if (this.transport.supportsWriteSettlement !== true && this.saturated) {
          this.settleOnDrain.add(entry)
        } else if (this.transport.supportsWriteSettlement !== true) {
          this.handleWriteSettlement(entry, ACCEPTED)
        }
      } else if (this.transport.supportsWriteSettlement !== true) {
        this.handleWriteSettlement(entry, ACCEPTED)
      }
      if (callbackResult) {
        this.handleWriteSettlement(entry, callbackResult)
      }
    } catch (error) {
      this.writing = false
      writeReturned = true
      if (callbackResult) {
        this.handleWriteSettlement(entry, callbackResult)
      }
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleWriteSettlement(entry: WriterEntry, result: MultiplexerWriteSettlement): void {
    if (entry.settled) {
      return
    }
    this.release(entry, result)
    if (result.outcome !== 'accepted') {
      this.fail(result.error)
      return
    }
    this.pump()
  }

  private handleDrain(): void {
    if (this.closed) {
      return
    }
    if (this.writing) {
      this.drainObservedDuringWrite = true
      return
    }
    if (!this.saturated) {
      return
    }
    this.setSaturated(false)
    for (const entry of Array.from(this.settleOnDrain)) {
      this.release(entry, ACCEPTED)
    }
    this.settleOnDrain.clear()
    this.pump()
  }

  private retain(entry: WriterEntry): void {
    if (entry.lane === 'ordinary') {
      this.ordinaryBytes += entry.data.length
      this.ordinaryFrames++
    } else {
      this.controlBytes += entry.data.length
      this.controlFrames++
    }
    if (entry.lane === 'liveness') {
      this.livenessOutstanding = true
    }
  }

  private release(entry: WriterEntry, result: MultiplexerWriteSettlement): void {
    if (entry.settled) {
      return
    }
    entry.settled = true
    // A transport failure after write started cannot prove the peer received no bytes.
    const settlement: MultiplexerWriteSettlement =
      result.outcome === 'refused' && this.inFlight.has(entry)
        ? {
            outcome: 'unverifiable',
            reason: 'transport_settlement_lost',
            bytesHandedToTransport: true,
            error: result.error
          }
        : result
    this.inFlight.delete(entry)
    this.settleOnDrain.delete(entry)
    if (entry.lane === 'ordinary') {
      this.ordinaryBytes -= entry.data.length
      this.ordinaryFrames--
    } else {
      this.controlBytes -= entry.data.length
      this.controlFrames--
    }
    if (entry.lane === 'liveness') {
      this.livenessOutstanding = false
    }
    entry.onSettled(settlement)
  }

  private setSaturated(saturated: boolean): void {
    if (this.saturated === saturated) {
      return
    }
    this.saturated = saturated
    this.onSaturationChange(saturated)
  }

  private fail(error: Error): void {
    if (this.closed) {
      return
    }
    this.dispose(error)
    this.onFailure(error)
  }
}
