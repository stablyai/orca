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

/**
 * Replies too big for one frame, split and put back together.
 *
 * A reply is never refused for being over the frame cap: the native screens have no reply byte cap,
 * so refusing one would invent a failure the phone does not have today. It is refused only over the
 * absolute ceiling, which aborts the request rather than truncating an answer the caller will read.
 */
export type BridgeReplySplit =
  | { ok: true; frames: BridgeReplyMessage[] }
  | { ok: false; refusal: BridgeRefusal }

export type BridgeReplyAssembly =
  | { status: 'pending' }
  | { status: 'complete'; payload: BridgeReplyPayload }
  | { status: 'failed'; refusal: BridgeRefusal }

/**
 * `of` is unknown until the split finishes, so a candidate frame is measured with the widest part
 * numbers the schema allows. A chunk that fits under that bound fits under the real one.
 */
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

/**
 * Measure, then accept: the frame that ships is the one that was weighed, so escaping a control
 * character or a surrogate split across the cut cannot push it over. A single code unit always
 * fits, since the envelope is under a hundred bytes against a 640 KiB frame.
 */
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

/**
 * A pair cut in half encodes as two replacements, three bytes each, where the pair is four: the
 * halves would disagree with the whole about the reply's size, and neither frame would be
 * well-formed UTF-8 for the native bridge to carry. Backing the cut up one unit costs one code unit
 * of a frame, and shrinking a frame that already fits keeps it fitting.
 */
function splitsASurrogatePair(serialized: string, end: number): boolean {
  if (end >= serialized.length) {
    return false
  }
  const last = serialized.charCodeAt(end - 1)
  const next = serialized.charCodeAt(end)
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}

/**
 * A reply at the ceiling splits into fewer parts than the schema admits, because a chunk is JSON
 * text re-escaped inside a JSON string and that at worst doubles it. The part cap is stated once,
 * by `replyPartSchema`; the derivation is pinned by this module's test.
 */
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

/**
 * Every half-assembled reply together. Without it, the per-reply ceiling times the in-flight cap is
 * half a gigabyte of parts that never complete. Four whole replies at once is more than the page
 * asks for and far less than the phone can lose.
 */
const BRIDGE_MAX_ASSEMBLING_BYTES = BRIDGE_MAX_REPLY_BYTES * 4

/**
 * Parts may arrive in any order, so they are held by index rather than appended.
 *
 * A failed id stays failed. Dropping it and starting over on the next part is what lets a sender
 * walk past the ceiling one refusal at a time, so the refusal is remembered and every later part
 * for that id gets the same answer. `discard` is how the page says the id is finished with, which
 * is also how it becomes usable again.
 *
 * The number of ids held at once is bounded by the in-flight request cap, since a reply only exists
 * for a request the page made, and their bytes together by `BRIDGE_MAX_ASSEMBLING_BYTES`. Nothing
 * here expires an id on its own, so C0.4 has to `discard` the id of every request it settles or
 * abandons, or a lost final part holds a slot until teardown.
 */
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
    // Code units, not bytes: a reply is never fewer bytes than code units, so this bounds what is
    // held without refusing a reply the joined measurement would accept. The ceiling itself is
    // checked once, on the joined text, because a pair split across two parts is four bytes whole
    // and six counted half by half.
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

  /** For a request the page abandoned, and for teardown. Also how a refused id is reopened. */
  discard(id: string): void {
    this.pending.delete(id)
    this.refused.delete(id)
  }

  clear(): void {
    this.pending.clear()
    this.refused.clear()
  }

  /** Code units, for the same reason the per-reply bound counts them: never more than the bytes. */
  private assemblingUnits(): number {
    let units = 0
    for (const entry of this.pending.values()) {
      units += entry.units
    }
    return units
  }

  private fail(id: string, refusal: BridgeRefusal): BridgeReplyAssembly {
    this.pending.delete(id)
    // The oldest refusal goes rather than the map growing: an id the page has not discarded in 64
    // refusals is one it is no longer waiting on.
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

/**
 * The reassembled body is checked as a reply payload and against the reply ceiling, which the
 * assembler already applied, and against nothing else: the document caps bound the page's traffic,
 * not the desktop's answers.
 */
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
