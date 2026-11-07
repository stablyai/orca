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
// Frames are ready JSON: the payload is serialized once and spliced into envelopes that match JSON.stringify of the frame objects byte for byte.
export type BridgeReplySplit =
  | { ok: true; frames: string[] }
  | { ok: false; refusal: BridgeRefusal }

export type BridgeReplyAssembly =
  | { status: 'pending' }
  | { status: 'complete'; payload: BridgeReplyPayload }
  | { status: 'failed'; refusal: BridgeRefusal }

function partHead(head: string, i: number, of: number): string {
  return `${head}"part":{"i":${i},"of":${of}},"chunk":`
}

// Ship the exact measured frame so JSON escaping cannot exceed the cap; even a single code unit fits the envelope budget.
function nextChunk(
  serialized: string,
  start: number,
  envelopeBytes: number
): { end: number; escaped: string } {
  let end = Math.min(serialized.length, start + BRIDGE_MAX_MESSAGE_BYTES)
  for (;;) {
    const escaped = JSON.stringify(serialized.slice(start, end))
    const bytes = envelopeBytes + utf8ByteLength(escaped)
    if (end - start <= 1 || bytes <= BRIDGE_MAX_MESSAGE_BYTES) {
      return end - start > 1 && splitsASurrogatePair(serialized, end)
        ? { end: end - 1, escaped: JSON.stringify(serialized.slice(start, end - 1)) }
        : { end, escaped }
    }
    const scaled = Math.floor((end - start) * (BRIDGE_MAX_MESSAGE_BYTES / bytes))
    end = start + Math.max(1, Math.min(scaled, end - start - 1))
  }
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
  const payloadBytes = utf8ByteLength(serialized)
  if (payloadBytes > BRIDGE_MAX_REPLY_BYTES) {
    return { ok: false, refusal: 'reply-too-large' }
  }
  // Envelope text is ASCII-delimited, so its bytes add to the payload's without recounting the payload.
  const head = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"reply","id":${JSON.stringify(id)},`
  const wholeHead = `${head}"payload":`
  if (utf8ByteLength(wholeHead) + payloadBytes + 1 <= BRIDGE_MAX_MESSAGE_BYTES) {
    return { ok: true, frames: [`${wholeHead}${serialized}}`] }
  }
  // Measure with the widest allowed part counters because `of` is unknown until splitting finishes.
  const envelopeBytes =
    utf8ByteLength(partHead(head, BRIDGE_MAX_REPLY_PARTS, BRIDGE_MAX_REPLY_PARTS)) + 1
  const frames: string[] = []
  for (let start = 0; start < serialized.length;) {
    const chunk = nextChunk(serialized, start, envelopeBytes)
    frames.push(chunk.escaped)
    start = chunk.end
  }
  // Wrap in place so each escaped chunk can be released as its frame is built.
  for (let index = 0; index < frames.length; index += 1) {
    frames[index] = `${partHead(head, index, frames.length)}${frames[index]}}`
  }
  return { ok: true, frames }
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
