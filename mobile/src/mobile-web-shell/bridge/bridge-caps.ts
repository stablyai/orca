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
 * The initial route bounds.
 *
 * The page writes this path into its own history before it renders, so it is held to what a path
 * may be rather than to what a screen may want: rooted, carrying neither a query nor a fragment
 * because the params are a field of their own, and made of segments that name something.
 *
 * Shape alone is not enough, because `replaceState` normalises what it is given and the page then
 * renders whatever came out. A protocol-relative `//host` throws a cross-origin `SecurityError` and
 * takes the mount down; `/../../etc` resolves to `/etc` and `/h/a\b` to `/h/a/b`, both of which
 * escape the `/h/` prefix the page's route tree starts at and land on a screen nobody asked for.
 * So: no empty segment, no dot segment, no backslash anywhere — none of which a route can produce.
 * A dot segment counts however it is spelled: a URL parser percent-decodes the path before it
 * resolves it, so `/h/%2e%2e/x` climbs out of the prefix exactly as `/h/../x` does. An escape
 * inside a segment that names something (`/h/a%20b`, `/h/%2ex`) is text and stays allowed.
 */
export const BRIDGE_MAX_ROUTE_PATHNAME_CHARS = 1024
export const BRIDGE_MAX_ROUTE_PARAMS = 32
export const BRIDGE_MAX_ROUTE_PARAM_CHARS = 1024

/**
 * One segment of a route path, and the only place the rule is written.
 *
 * Exported as source rather than as a regex because it is embedded in more than one pattern: the
 * `init` pathname and the hrefs a page hands back to the shell are the same vocabulary, and two
 * spellings of it would be two rules that drift.
 *
 * Which is why the dot-segment lookahead ends a segment at `?` as well as at `/` and at the end of
 * the string. A pathname carries no query, but an href does, so `/h/..?x` reaches the shared rule.
 * The harm there is not the climb `replaceState` performs on the pathname: the href's sink is the
 * native router, which resolves a dot segment only for an href beginning with `.` and otherwise
 * matches segments literally, so `..` is taken as a value for `[hostId]` and the shell opens a host
 * screen for an id no host has. Different screen, same reason to refuse it.
 *
 * Widening the boundary cannot loosen the pathname pattern, where a `?` fails the character class
 * wherever it appears.
 */
export const BRIDGE_ROUTE_SEGMENT_SOURCE = String.raw`(?!(?:\.|%2[eE]){1,2}(?:[/?]|$))[^/\\?#\s]+`

/** The path half both patterns start from: rooted, and made of segments that name something. */
const ROUTE_PATH_SOURCE = `/(?:${BRIDGE_ROUTE_SEGMENT_SOURCE}(?:/${BRIDGE_ROUTE_SEGMENT_SOURCE})*/?)?`

export const BRIDGE_ROUTE_PATHNAME_PATTERN = new RegExp(`^${ROUTE_PATH_SOURCE}$`)

/** A `navigate` target: the same path, plus the query the screen is opened with. Still no
 *  fragment — the shell matches on a pathname, and a `#` is the page's own business.
 *
 *  Shape only. Whether the target names a screen the app actually has is a different question and
 *  a later one: with no `+not-found` file, expo-router's Unmatched paints over the shell for a
 *  well-formed path nobody routes. C1.7 owns that check. */
export const BRIDGE_ROUTE_HREF_PATTERN = new RegExp(
  String.raw`^${ROUTE_PATH_SOURCE}(?:\?[^#\s]*)?$`
)
export const BRIDGE_MAX_ROUTE_HREF_CHARS = 2048

/**
 * The schemes a page may ask the shell to open in the system browser, and the only three.
 *
 * `https:` and `http:` are what every provider's task source is, and `mailto:` is what a review
 * thread produces. Everything else — `javascript:`, `data:`, `file:`, `intent:`, the shell's own
 * `orca-mobile-web:` — is a way to reach something the page was never granted, so the list is
 * closed. Broad inside it on purpose: any host and any path, because a grant that named GitHub
 * would have to grow a row per provider.
 */
export const BRIDGE_EXTERNAL_LINK_SCHEMES: readonly string[] = ['https:', 'http:', 'mailto:']

/** The same bound a route href gets: one cap for every URL that crosses, in either direction. */
export const BRIDGE_MAX_EXTERNAL_LINK_CHARS = BRIDGE_MAX_ROUTE_HREF_CHARS

/**
 * The URL the shell will open, as the parser reads it, or null when it is not one the grant covers.
 *
 * Parsed rather than prefix-matched, because a scheme is what a URL parser says it is and
 * `startsWith('https:')` reads one out of `javascript:alert("https://x")`. `URL` with no base
 * accepts only an absolute URL, which is the rest of the rule: a relative target is a route, and
 * routes go back over `navigate`.
 *
 * The parsed href is what callers forward, never the string they were handed. The WHATWG parser
 * strips tab, LF and CR from anywhere and trims leading C0 and space before it reads the scheme, so
 * `ht\ntps://example.com` and `https:example.com` pass this check and are not what a device handler
 * should be given. Normalizing is the fix and comparing is not: `https://example.com` differs from
 * its own href by a path slash, so refusing what differs would refuse an ordinary URL.
 */
export function readBridgeExternalLinkUrl(url: string): string | null {
  // The raw string first, so a hostile one is refused without being parsed. The normalized form is
  // bounded too, below: percent-encoding expands, so a string inside the cap can leave it.
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

/** Whether the shell will open this URL at all. The envelope's refine; the value is read above. */
export function isBridgeExternalLinkUrl(url: string): boolean {
  return readBridgeExternalLinkUrl(url) !== null
}
export const BRIDGE_MAX_PAGE_ROUTES = 64
/** A host id, its name and its endpoint. Bounded because the page renders all three. */
export const BRIDGE_MAX_HOST_FIELD_CHARS = 1024

/**
 * In-flight bounds. The RN host is authoritative for both; the page holds the same numbers only to
 * refuse at the call site instead of after a round trip.
 */
export const BRIDGE_MAX_PENDING_REQUESTS = 64
export const BRIDGE_MAX_SUBSCRIPTIONS = 32

/**
 * Viewport bounds, held to the desktop's `TerminalViewport` by the envelope's test.
 *
 * A viewport the page sends is written into the cached subscribe params of every stream naming that
 * terminal, the native terminal screens' included, and the desktop refuses an out-of-range one when
 * those streams resubscribe. Refusing it at the frame is what keeps a bad page's reach inside its
 * own document.
 */
export const BRIDGE_MAX_VIEWPORT_COLS = 1000
export const BRIDGE_MAX_VIEWPORT_ROWS = 500

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
