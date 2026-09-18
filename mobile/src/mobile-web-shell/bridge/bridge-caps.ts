/**
 * The bridge's caps, its refusal vocabulary, and the single point that enforces them.
 *
 * Every frame crossing the page <-> shell boundary is read through `parseBridgeMessage`. It is the
 * only place these bounds are checked: a second check drifts from the first, and a check placed
 * after `JSON.parse` cannot protect the parse itself.
 *
 * The two directions are not symmetric. What the shell reads from the page is attacker-shaped, so
 * it is walked for depth and node count. What the page reads from the shell is whatever the desktop
 * answered, where a listing of a few thousand rows is an ordinary reply: a node cap there would
 * refuse real data, so the frame byte cap and the reply ceiling are that direction's only bounds.
 */

/** Which side sent the frame. The document caps below bound `page-to-shell` only. */
export const BRIDGE_DIRECTIONS = ['page-to-shell', 'shell-to-page'] as const

export type BridgeDirection = (typeof BRIDGE_DIRECTIONS)[number]

/** Frame ceiling, in UTF-8 bytes of the raw string, checked before `JSON.parse` sees it. */
export const BRIDGE_MAX_MESSAGE_BYTES = 640 * 1024

/** Nesting levels a page-to-shell frame may carry, counting the frame object itself as one. */
export const BRIDGE_MAX_DEPTH = 16

/** Values a page-to-shell frame may carry, containers and scalars alike. */
export const BRIDGE_MAX_NODES = 20_000

/** Longest method name accepted. The desktop's mobile-scope allowlist owns which names exist. */
export const BRIDGE_MAX_METHOD_CHARS = 64

/**
 * In-flight bounds. The RN host is authoritative for both; the page holds the same numbers only to
 * refuse at the call site instead of after a round trip.
 */
export const BRIDGE_MAX_PENDING_REQUESTS = 64
export const BRIDGE_MAX_SUBSCRIPTIONS = 32

/**
 * A reply above this aborts its request rather than being chunked further. The frame cap is a
 * transport bound; this is the policy. The native screens have no reply byte cap at all, so a
 * smaller number here would invent a refusal that source control's diffs would be the first to hit.
 */
export const BRIDGE_MAX_REPLY_BYTES = 8 * 1024 * 1024

/**
 * Parts a chunked reply may be split into. A chunk is a slice of JSON text carried inside a JSON
 * string, and re-escaping such a slice at worst doubles it: every character it holds is already
 * printable, so only a quote or a backslash grows, and each of those grows by one byte. The extra
 * part covers each frame's own envelope.
 */
export const BRIDGE_MAX_REPLY_PARTS =
  Math.ceil((BRIDGE_MAX_REPLY_BYTES * 2) / BRIDGE_MAX_MESSAGE_BYTES) + 1

/** Why a frame was dropped. Both sides log this name; none of them is recoverable in place. */
export const BRIDGE_REFUSALS = [
  /** Over the frame cap. */
  'oversized',
  /** Not JSON, or nested past what `JSON.parse` itself will walk. */
  'malformed-json',
  /** Nested past `BRIDGE_MAX_DEPTH`, which only `page-to-shell` is held to. */
  'too-deep',
  /** More values than `BRIDGE_MAX_NODES`, which only `page-to-shell` is held to. */
  'too-many-nodes',
  /** Valid JSON that is not a message this protocol version declares. */
  'unrecognised-message',
  /** A reply body over `BRIDGE_MAX_REPLY_BYTES`, refused by the sender and by the assembler. */
  'reply-too-large',
  /** A reply part that disagrees with the parts already held for its id. */
  'inconsistent-part',
  /** A reply part index that arrived twice. */
  'duplicate-part',
  /** A part for a new id while `BRIDGE_MAX_PENDING_REQUESTS` replies are already half-assembled. */
  'too-many-pending'
] as const

export type BridgeRefusal = (typeof BRIDGE_REFUSALS)[number]

export type BridgeRead<TMessage> =
  | { ok: true; message: TMessage }
  | { ok: false; refusal: BridgeRefusal }

/** Exact UTF-8 length; a lone surrogate counts as the three bytes its replacement encodes to. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

type DocumentRefusal = Extract<BridgeRefusal, 'too-deep' | 'too-many-nodes'>

function childrenOf(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value
  }
  return typeof value === 'object' && value !== null ? Object.values(value) : null
}

/**
 * Depth-first with an explicit stack, counting children as they are pushed so a wide container is
 * refused before its values are queued.
 */
function inspectDocument(root: unknown): DocumentRefusal | null {
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 1 }]
  let nodes = 1
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    if (entry.depth > BRIDGE_MAX_DEPTH) {
      return 'too-deep'
    }
    const children = childrenOf(entry.value)
    if (children === null) {
      continue
    }
    nodes += children.length
    if (nodes > BRIDGE_MAX_NODES) {
      return 'too-many-nodes'
    }
    for (const child of children) {
      pending.push({ value: child, depth: entry.depth + 1 })
    }
  }
  return null
}

/**
 * Parses a frame far enough to hand it to a schema, and no further. `direction` has no default: a
 * new call site has to say which bounds it is asking for.
 */
export function parseBridgeMessage(raw: string, direction: BridgeDirection): BridgeRead<unknown> {
  // A code unit never encodes to fewer than one byte, so a string longer than the cap in units is
  // over it in bytes too: the hostile case is refused without walking it.
  if (raw.length > BRIDGE_MAX_MESSAGE_BYTES || utf8ByteLength(raw) > BRIDGE_MAX_MESSAGE_BYTES) {
    return { ok: false, refusal: 'oversized' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A nesting bomb that overflows `JSON.parse`'s own recursion lands here rather than below.
    return { ok: false, refusal: 'malformed-json' }
  }
  if (direction === 'shell-to-page') {
    return { ok: true, message: parsed }
  }
  const refusal = inspectDocument(parsed)
  return refusal === null ? { ok: true, message: parsed } : { ok: false, refusal }
}
