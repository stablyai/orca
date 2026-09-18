import {
  BRIDGE_MAX_MESSAGE_BYTES,
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
  return end
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

type PendingReply = { of: number; chunks: Map<number, string>; bytes: number }

/**
 * Parts may arrive in any order, so they are held by index rather than appended. Every failure drops
 * the id: a half-assembled reply whose sender has already moved on is not worth holding.
 */
export class BridgeReplyAssembler {
  private readonly pending = new Map<string, PendingReply>()

  accept(message: BridgeReplyMessage): BridgeReplyAssembly {
    if (!('part' in message)) {
      this.pending.delete(message.id)
      return { status: 'complete', payload: message.payload }
    }
    const { id, part, chunk } = message
    const held = this.pending.get(id)
    if (part.i >= part.of || (held !== undefined && held.of !== part.of)) {
      return this.fail(id, 'inconsistent-part')
    }
    const entry = held ?? { of: part.of, chunks: new Map<number, string>(), bytes: 0 }
    if (entry.chunks.has(part.i)) {
      return this.fail(id, 'duplicate-part')
    }
    const bytes = entry.bytes + utf8ByteLength(chunk)
    if (bytes > BRIDGE_MAX_REPLY_BYTES) {
      return this.fail(id, 'reply-too-large')
    }
    entry.chunks.set(part.i, chunk)
    entry.bytes = bytes
    this.pending.set(id, entry)
    if (entry.chunks.size < entry.of) {
      return { status: 'pending' }
    }
    this.pending.delete(id)
    return readAssembledPayload(entry)
  }

  /** For a request the page abandoned, and for teardown. */
  discard(id: string): void {
    this.pending.delete(id)
  }

  clear(): void {
    this.pending.clear()
  }

  private fail(id: string, refusal: BridgeRefusal): BridgeReplyAssembly {
    this.pending.delete(id)
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
