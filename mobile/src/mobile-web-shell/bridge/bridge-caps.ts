import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../../src/shared/mobile-bridge-frame-bytes'

// Bound raw bytes before JSON.parse. Walk page-to-shell frames for depth/node limits, but not desktop replies: ordinary listings may contain thousands of rows.
// Shell-to-page traffic retains frame/reply byte ceilings; share these predicates so sender and receiver bounds cannot drift.

export const BRIDGE_DIRECTIONS = ['page-to-shell', 'shell-to-page'] as const

export type BridgeDirection = (typeof BRIDGE_DIRECTIONS)[number]

// Check raw UTF-8 bytes before parsing; never raise alone because hosts target released shells’ caps.
export const BRIDGE_MAX_MESSAGE_BYTES = MOBILE_BRIDGE_MAX_FRAME_BYTES

export const BRIDGE_MAX_DEPTH = 16

export const BRIDGE_MAX_NODES = 20_000

export const BRIDGE_MAX_METHOD_CHARS = 64

// Routes enter replaceState before render; keep params separate and reject empty/dot/backslash segments that URL normalization can redirect outside the intended host.
// Reject percent-encoded dot segments too, while allowing escapes inside named segments such as a%20b or %2ex.
export const BRIDGE_MAX_ROUTE_PATHNAME_CHARS = 1024
export const BRIDGE_MAX_ROUTE_PARAMS = 32
export const BRIDGE_MAX_ROUTE_PARAM_CHARS = 1024

// Share this segment source between pathnames and navigation hrefs. End dot-segment checks at ? too: Expo Router 55.0.18 normalizes /h/..?x to / before route matching.
export const BRIDGE_ROUTE_SEGMENT_SOURCE = String.raw`(?!(?:\.|%2[eE]){1,2}(?:[/?]|$))[^/\\?#\s]+`

const ROUTE_PATH_SOURCE = `/(?:${BRIDGE_ROUTE_SEGMENT_SOURCE}(?:/${BRIDGE_ROUTE_SEGMENT_SOURCE})*/?)?`

export const BRIDGE_ROUTE_PATHNAME_PATTERN = new RegExp(`^${ROUTE_PATH_SOURCE}$`)

// Navigation adds query params to the shared path rule, never fragments. This validates shape only; the host catch-all/manifest decides whether a screen exists.
export const BRIDGE_ROUTE_HREF_PATTERN = new RegExp(
  String.raw`^${ROUTE_PATH_SOURCE}(?:\?[^#\s]*)?$`
)
export const BRIDGE_MAX_ROUTE_HREF_CHARS = 2048

// Allow only http/https provider links and mailto review links; arbitrary hosts remain valid, but other schemes exceed the external-link grant.
export const BRIDGE_EXTERNAL_LINK_SCHEMES: readonly string[] = ['https:', 'http:', 'mailto:']

export const BRIDGE_MAX_EXTERNAL_LINK_CHARS = BRIDGE_MAX_ROUTE_HREF_CHARS

// Parse absolute URLs without a base; relative targets belong to navigate. Forward the normalized href so device handling sees the same URL that passed the scheme check.
// Normalize rather than rejecting changed spellings: bare origins gain a slash, while WHATWG strips controls/space before interpreting schemes.
export function readBridgeExternalLinkUrl(url: string): string | null {
  // Bound before parsing, then bound normalized output too because percent-encoding can expand it.
  if (url.length > BRIDGE_MAX_EXTERNAL_LINK_CHARS) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!BRIDGE_EXTERNAL_LINK_SCHEMES.includes(parsed.protocol)) {
    return null
  }
  return parsed.href.length > BRIDGE_MAX_EXTERNAL_LINK_CHARS ? null : parsed.href
}

export function isBridgeExternalLinkUrl(url: string): boolean {
  return readBridgeExternalLinkUrl(url) !== null
}
export const BRIDGE_MAX_PAGE_ROUTES = 64

export const BRIDGE_MAX_HOST_FIELD_CHARS = 1024

// The native host enforces in-flight caps; page-side copies fail early to avoid a wasted round trip.
export const BRIDGE_MAX_PENDING_REQUESTS = 64
export const BRIDGE_MAX_SUBSCRIPTIONS = 32

// Viewport updates change cached terminal subscription params, including native streams; enforce desktop ranges at the frame so a bad page cannot poison resubscription.
export const BRIDGE_MAX_VIEWPORT_COLS = 1000
export const BRIDGE_MAX_VIEWPORT_ROWS = 500

// Keep reply policy separate from frame transport limits; lowering it invents failures for large diffs that native screens accept.
export const BRIDGE_MAX_REPLY_BYTES = 8 * 1024 * 1024

// Reply parts embed printable JSON in JSON strings, at worst doubling quotes/backslashes; reserve an extra part for frame envelopes.
export const BRIDGE_MAX_REPLY_PARTS =
  Math.ceil((BRIDGE_MAX_REPLY_BYTES * 2) / BRIDGE_MAX_MESSAGE_BYTES) + 1

export const BRIDGE_REFUSALS = [
  'oversized',
  'malformed-json',
  'too-deep',
  'too-many-nodes',
  'unrecognised-message',
  'reply-too-large',
  'inconsistent-part',
  'duplicate-part',
  'too-many-pending'
] as const

export type BridgeRefusal = (typeof BRIDGE_REFUSALS)[number]

export type BridgeRead<TMessage> =
  | { ok: true; message: TMessage }
  | { ok: false; refusal: BridgeRefusal }

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

// Count children before pushing them so wide containers fail without allocating a queue for all their values.
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

// Share the receiver’s size predicate so senders refuse early instead of posting frames that get dropped without reply.
// Code-unit length is a cheap safe rejection: each unit encodes to at least one UTF-8 byte; byte length decides the rest.
export function isBridgeFrameWithinCap(raw: string): boolean {
  return raw.length <= BRIDGE_MAX_MESSAGE_BYTES && utf8ByteLength(raw) <= BRIDGE_MAX_MESSAGE_BYTES
}

// Require an explicit direction because only page-to-shell frames receive document limits.
export function parseBridgeMessage(raw: string, direction: BridgeDirection): BridgeRead<unknown> {
  if (!isBridgeFrameWithinCap(raw)) {
    return { ok: false, refusal: 'oversized' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, refusal: 'malformed-json' }
  }
  if (direction === 'shell-to-page') {
    return { ok: true, message: parsed }
  }
  const refusal = inspectDocument(parsed)
  return refusal === null ? { ok: true, message: parsed } : { ok: false, refusal }
}
