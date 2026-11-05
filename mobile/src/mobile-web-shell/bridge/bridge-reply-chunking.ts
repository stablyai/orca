import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_REPLY_BYTES,
  BRIDGE_MAX_REPLY_PARTS,
  utf8ByteLength,
  type BridgeRefusal
} from './bridge-caps'
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeReplyPayloadSchema,
  type BridgeReplyMessage,
  type BridgeReplyPayload
} from './bridge-envelope'

// Split replies above the frame cap rather than inventing native-incompatible refusals; abort only above the absolute reply ceiling, never truncate the caller’s answer.
export type BridgeReplySplit =
  | { ok: true; frames: BridgeReplyMessage[] }
  | { ok: false; refusal: BridgeRefusal }

export type BridgeReplyAssembly =
  | { status: 'pending' }
  | { status: 'complete'; payload: BridgeReplyPayload }
  | { status: 'failed'; refusal: BridgeRefusal }

// Measure with the widest allowed part counters because `of` is unknown until splitting finishes.
function partFrameBytes(id: string, chunk: string): number {
  return utf8ByteLength(
    JSON.stringify({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id,
      part: { i: BRIDGE_MAX_REPLY_PARTS, of: BRIDGE_MAX_REPLY_PARTS },
      chunk
    })
  )
}

// Ship the exact measured frame so JSON escaping cannot exceed the cap; even a single code unit fits the envelope budget.
function chunkEnd(id: string, serialized: string, start: number): number {
  let end = Math.min(serialized.length, start + BRIDGE_MAX_MESSAGE_BYTES)
  while (end - start > 1) {
    const bytes = partFrameBytes(id, serialized.slice(start, end))
    if (bytes <= BRIDGE_MAX_MESSAGE_BYTES) {
      break
    }
    const scaled = Math.floor((end - start) * (BRIDGE_MAX_MESSAGE_BYTES / bytes))
    end = start + Math.max(1, Math.min(scaled, end - start - 1))
  }
  return end - start > 1 && splitsASurrogatePair(serialized, end) ? end - 1 : end
}

// Keep surrogate pairs together so chunk byte counts agree with the joined reply; backing up one unit preserves a frame that already fits.
function splitsASurrogatePair(serialized: string, end: number): boolean {
  if (end >= serialized.length) {
    return false
  }
  const last = serialized.charCodeAt(end - 1)
  const next = serialized.charCodeAt(end)
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}

// JSON-in-JSON escaping at worst doubles printable reply text; tests pin the maximum accepted reply below replyPartSchema’s part count.
export function splitBridgeReply(id: string, payload: BridgeReplyPayload): BridgeReplySplit {
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    return { ok: false, refusal: 'malformed-json' }
  }
  if (utf8ByteLength(serialized) > BRIDGE_MAX_REPLY_BYTES) {
    return { ok: false, refusal: 'reply-too-large' }
  }
  const whole: BridgeReplyMessage = { v: BRIDGE_PROTOCOL_VERSION, type: 'reply', id, payload }
  if (utf8ByteLength(JSON.stringify(whole)) <= BRIDGE_MAX_MESSAGE_BYTES) {
    return { ok: true, frames: [whole] }
  }
  const chunks: string[] = []
  for (let start = 0; start < serialized.length;) {
    const end = chunkEnd(id, serialized, start)
    chunks.push(serialized.slice(start, end))
    start = end
  }
  return {
    ok: true,
    frames: chunks.map((chunk, index) => ({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id,
      part: { i: index, of: chunks.length },
      chunk
    }))
  }
}

type PendingReply = { of: number; chunks: Map<number, string>; units: number }

// Bound aggregate assembly memory too; per-reply ceiling times request cap otherwise permits half a gigabyte of incomplete parts.
const BRIDGE_MAX_ASSEMBLING_BYTES = BRIDGE_MAX_REPLY_BYTES * 4

// Hold out-of-order parts by index and retain refusal until discard; restarting failed ids would let senders evade the ceiling.
// Bound ids and aggregate bytes; request bookkeeping must discard settled/abandoned ids because the assembler has no expiry.
export class BridgeReplyAssembler {
  private readonly pending = new Map<string, PendingReply>()
  private readonly refused = new Map<string, BridgeRefusal>()

  accept(message: BridgeReplyMessage): BridgeReplyAssembly {
    const refusal = this.refused.get(message.id)
    if (refusal !== undefined) {
      return { status: 'failed', refusal }
    }
    if (!('part' in message)) {
      this.pending.delete(message.id)
      return { status: 'complete', payload: message.payload }
    }
    const { id, part, chunk } = message
    const held = this.pending.get(id)
    if (part.i >= part.of || (held !== undefined && held.of !== part.of)) {
      return this.fail(id, 'inconsistent-part')
    }
    if (held === undefined && this.pending.size >= BRIDGE_MAX_PENDING_REQUESTS) {
      return this.fail(id, 'too-many-pending')
    }
    const entry = held ?? { of: part.of, chunks: new Map<number, string>(), units: 0 }
    if (entry.chunks.has(part.i)) {
      return this.fail(id, 'duplicate-part')
    }
    if (this.assemblingUnits() + chunk.length > BRIDGE_MAX_ASSEMBLING_BYTES) {
      return this.fail(id, 'too-many-pending')
    }
    // Bound held code units, then measure joined UTF-8 once: surrogate halves cost six bytes separately but their pair costs four.
    const units = entry.units + chunk.length
    if (units > BRIDGE_MAX_REPLY_BYTES) {
      return this.fail(id, 'reply-too-large')
    }
    entry.chunks.set(part.i, chunk)
    entry.units = units
    this.pending.set(id, entry)
    if (entry.chunks.size < entry.of) {
      return { status: 'pending' }
    }
    this.pending.delete(id)
    return readAssembledPayload(entry)
  }

  discard(id: string): void {
    this.pending.delete(id)
    this.refused.delete(id)
  }

  clear(): void {
    this.pending.clear()
    this.refused.clear()
  }

  private assemblingUnits(): number {
    let units = 0
    for (const entry of this.pending.values()) {
      units += entry.units
    }
    return units
  }

  private fail(id: string, refusal: BridgeRefusal): BridgeReplyAssembly {
    this.pending.delete(id)
    // Evict the oldest refusal at the bound; unobserved tombstones must not grow forever.
    if (this.refused.size >= BRIDGE_MAX_PENDING_REQUESTS) {
      const oldest = this.refused.keys().next()
      if (!oldest.done) {
        this.refused.delete(oldest.value)
      }
    }
    this.refused.set(id, refusal)
    return { status: 'failed', refusal }
  }
}

// Apply reply schema/byte ceiling only; page document-depth/node caps must not reject ordinary desktop listings.
function readAssembledPayload(entry: PendingReply): BridgeReplyAssembly {
  const joined = [...entry.chunks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, chunk]) => chunk)
    .join('')
  if (utf8ByteLength(joined) > BRIDGE_MAX_REPLY_BYTES) {
    return { status: 'failed', refusal: 'reply-too-large' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(joined)
  } catch {
    return { status: 'failed', refusal: 'malformed-json' }
  }
  const payload = BridgeReplyPayloadSchema.safeParse(parsed)
  return payload.success
    ? { status: 'complete', payload: payload.data }
    : { status: 'failed', refusal: 'unrecognised-message' }
}
