import { createHash } from 'node:crypto'
import { isRecord } from '../../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

/** An `orca agent read` stopped inside one journal row: which of that row's raw slots it has
 *  represented, pinned to the row's sequence, slot count and slot fingerprint. */
export type AgentReadPartialRow = {
  row: number
  count: number
  fingerprint: string
  /** base64url bitset, one bit per raw slot, padding bits zero. */
  emitted: string
}

const FINGERPRINT = /^[\w-]{22}$/

/** The row's kind and raw slots in order, each length-delimited, as 128 bits of SHA-256. */
export function agentReadRowFingerprint(kind: string, slots: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of [kind, ...slots]) {
    hash.update(`${Buffer.byteLength(part)}:${part}`)
  }
  return hash.digest('base64url').slice(0, 22)
}

/** Which raw slots of one row have been represented. */
export class EmittedSlots {
  private constructor(private readonly bits: Uint8Array) {}

  static none(count: number): EmittedSlots {
    return new EmittedSlots(new Uint8Array(Math.ceil(count / 8)))
  }

  /** Null unless `emitted` is the canonical encoding of exactly `count` bits. */
  static decode(emitted: string, count: number): EmittedSlots | null {
    const bits = new Uint8Array(Buffer.from(emitted, 'base64url'))
    const slots = new EmittedSlots(bits)
    const padding = bits.length * 8 - count
    const last = bits.at(-1) ?? 0
    return bits.length === Math.ceil(count / 8) &&
      slots.encode() === emitted &&
      (last & ((1 << padding) - 1)) === 0
      ? slots
      : null
  }

  has(slot: number): boolean {
    return ((this.bits[slot >> 3] ?? 0) & (0x80 >> (slot & 7))) !== 0
  }

  add(slot: number): void {
    this.bits[slot >> 3] = (this.bits[slot >> 3] ?? 0) | (0x80 >> (slot & 7))
  }

  encode(): string {
    return Buffer.from(this.bits).toString('base64url')
  }
}

/** A well-formed partial row strictly after the consumed `frontier`. */
export function isAgentReadPartialRow(
  value: unknown,
  frontier: number
): value is AgentReadPartialRow {
  if (!isRecord(value)) {
    return false
  }
  const { row, count, fingerprint, emitted } = value
  return (
    Number.isSafeInteger(row) &&
    typeof row === 'number' &&
    row > frontier &&
    Number.isSafeInteger(count) &&
    typeof count === 'number' &&
    count >= 0 &&
    typeof fingerprint === 'string' &&
    FINGERPRINT.test(fingerprint) &&
    typeof emitted === 'string' &&
    EmittedSlots.decode(emitted, count) !== null
  )
}

/** Bytes a cursor carrying a partial row of `count` slots can add to a reply. */
export function agentReadPartialRowBytes(count: number): number {
  return 1024 + Math.ceil(count / 8) * 2
}
