import type { Socket } from 'node:net'
import type { DaemonEvent } from './daemon-stream-events'
import { BINARY_STREAM_FRAMING, type DaemonStreamFraming } from './daemon-stream-binary-framing'

const CONNECTION_BYTES = 4 * 1024 * 1024
const BINDING_BYTES = 64 * 1024
const RECORD_BYTES = 16 * 1024
const CONNECTION_RECORDS = 4096
const BINDING_RECORDS = 128
const BASE_BYTES = 512
const SHARED_BYTES = 4096
const RECORD_OVERHEAD = 1024
export type RecordCounter = { bytes: number; records: number }
export type SocketGeneration = { records: number; detach: () => void }

export type AdmittedTransientRecord = TransientEntryLease & {
  buffer: Buffer
  installBoundary: boolean
}

// Queue and socket callbacks retain numeric accounting, never a detached Session/getter.
export class TransientEntryLease {
  generation: SocketGeneration | null = null
  queryChars = 0
  constructor(
    readonly owner: TransientAccounting,
    readonly counter: RecordCounter,
    public bytes: number,
    public records = 1
  ) {}
  startWrite(socket: Socket): this {
    this.owner.startWrite(this, socket)
    return this
  }
  partition(bytes: number, records = 1, query = false): TransientEntryLease | null {
    return this.owner.reserve(this.counter, bytes, records, query)
  }
  capacityLost(): void {
    this.owner.discardQueued(this.counter)
  }
  absorb(source: TransientEntryLease, overhead = 0): void {
    this.owner.transfer(this, source, overhead)
  }
  release = (): void => this.owner.release(this)
}

/** A pre-encoding bound, including escaped UTF-16 and JSON punctuation, without making a copy. */
export function streamEventJsonBytes(value: unknown): number {
  if (typeof value === 'string') {
    let bytes = 2
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      ) {
        bytes += 2
      } else if (code < 32) {
        bytes += 6
      } else if (code < 128) {
        bytes++
      } else if (code < 2048) {
        bytes += 2
      } else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        value.charCodeAt(i + 1) >= 0xdc00 &&
        value.charCodeAt(i + 1) <= 0xdfff
      ) {
        bytes += 4
        i++
      } else {
        bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3
      }
      if (bytes > RECORD_BYTES) {
        break
      }
    }
    return bytes
  }
  if (typeof value === 'number') {
    return 24
  }
  if (typeof value === 'boolean' || value === null) {
    return 5
  }
  if (typeof value !== 'object') {
    return 0
  }
  let total = 2
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: own JSON fields are inspected only for a conservative sizing bound.
  const fields = value as Record<string, unknown>
  for (const key in fields) {
    if (!Object.hasOwn(fields, key)) {
      continue
    }
    total += 2 + streamEventJsonBytes(key) + streamEventJsonBytes(fields[key])
    if (total > RECORD_BYTES) {
      break
    }
  }
  return total
}

export abstract class TransientAccounting {
  protected readonly pending = new Set<TransientEntryLease>()
  protected bytes = SHARED_BYTES
  protected records = 0
  protected abstract get bindingCount(): number
  abstract startWrite(record: TransientEntryLease, socket: Socket): void
  abstract release(record: TransientEntryLease): void
  abstract discardQueued(counter: RecordCounter): void

  reserve(
    counter: RecordCounter,
    peak: number,
    records = 1,
    query = false
  ): TransientEntryLease | null {
    // Keep room for 4096 active bindings; payloads cannot consume their base admission reserve.
    const recordCapacity = CONNECTION_BYTES - SHARED_BYTES - 4096 * BASE_BYTES
    const recordBytes = this.bytes - SHARED_BYTES - this.bindingCount * BASE_BYTES
    if (
      BASE_BYTES + counter.bytes + peak > BINDING_BYTES - (query ? 0 : 9 * 1024) ||
      recordBytes + peak > recordCapacity - (query ? 0 : 800 * 1024) ||
      this.records + records > CONNECTION_RECORDS - (query ? 0 : 1400) ||
      counter.records + records > BINDING_RECORDS - (query ? 0 : 1)
    ) {
      return null
    }
    this.bytes += peak
    counter.bytes += peak
    this.records += records
    counter.records += records
    const lease = new TransientEntryLease(this, counter, peak, records)
    this.pending.add(lease)
    return lease
  }

  transfer(target: TransientEntryLease, source: TransientEntryLease, overhead: number): void {
    const bytes = source.bytes - overhead
    source.counter.bytes -= bytes
    target.counter.bytes += bytes
    target.bytes += bytes
    target.queryChars += source.queryChars
    source.bytes -= bytes
    source.queryChars = 0
    source.release()
  }

  split(source: TransientEntryLease, bytes: number): TransientEntryLease {
    // Staging precharges all child records and their materialization before extraction.
    source.bytes -= bytes
    source.records--
    const child = new TransientEntryLease(this, source.counter, bytes)
    this.pending.add(child)
    return child
  }

  encodeQueued(
    lease: TransientEntryLease,
    event: DaemonEvent,
    framing: DaemonStreamFraming
  ): Buffer | null {
    const upper = 5 + streamEventJsonBytes(event)
    if (upper > RECORD_BYTES || lease.bytes < 3 * upper + RECORD_OVERHEAD) {
      return null
    }
    try {
      const json = JSON.stringify(event)
      const bodyBytes = Buffer.byteLength(json)
      const binary = framing === BINARY_STREAM_FRAMING
      const buffer = Buffer.allocUnsafeSlow(bodyBytes + (binary ? 5 : 1))
      if (binary) {
        buffer[0] = 1
        buffer.writeUInt32BE(bodyBytes, 1)
      }
      buffer.write(json, binary ? 5 : 0)
      if (!binary) {
        buffer[bodyBytes] = 10
      }
      this.resize(lease, buffer.length + RECORD_OVERHEAD)
      return buffer
    } catch (error) {
      lease.release()
      throw error
    }
  }

  private resize(lease: TransientEntryLease, bytes: number): void {
    this.bytes += bytes - lease.bytes
    lease.counter.bytes += bytes - lease.bytes
    lease.bytes = bytes
  }
}
