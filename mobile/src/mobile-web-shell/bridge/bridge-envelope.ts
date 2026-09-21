import { z } from 'zod'
import { isRpcResponse } from '../../transport/rpc-response-shape'
import type { RpcResponse } from '../../transport/types'
import { BridgeErrorCaptureSchema } from './bridge-error-capture'
import { BRIDGE_HAPTICS_NOTIFY_FIELDS } from './bridge-haptics-notify'
import { BridgePageRouteGrantsSchema } from './bridge-page-route-grants'
import {
  isPageStorageKey,
  PAGE_STORAGE_MAX_ENTRIES,
  PAGE_STORAGE_MAX_KEY_CHARS,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../page-storage-keys'
import {
  BRIDGE_MAX_METHOD_CHARS,
  BRIDGE_MAX_PAGE_ROUTES,
  BRIDGE_MAX_REPLY_PARTS,
  BRIDGE_MAX_EXTERNAL_LINK_CHARS,
  BRIDGE_MAX_ROUTE_HREF_CHARS,
  BRIDGE_MAX_ROUTE_PARAM_CHARS,
  BRIDGE_MAX_ROUTE_PARAMS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_MAX_VIEWPORT_COLS,
  BRIDGE_MAX_VIEWPORT_ROWS,
  BRIDGE_MAX_HOST_FIELD_CHARS,
  BRIDGE_ROUTE_HREF_PATTERN,
  BRIDGE_ROUTE_PATHNAME_PATTERN,
  isBridgeExternalLinkUrl,
  parseBridgeMessage,
  type BridgeDirection,
  type BridgeRead
} from './bridge-caps'

/**
 * Every message the page and the shell exchange, in both directions.
 *
 * `v` gates envelope shape and nothing else: capability is gated by `init.grants`, so a shell that
 * learns a new native grant never bumps it. Unknown keys are dropped rather than refused, because
 * the page bundle is served by a desktop that updates independently of the installed shell, and an
 * additive field must not take a working pair offline. The rule, in one line: `v` gates
 * incompatible shape; additive fields never bump `v`.
 *
 * A new member of a closed list is NOT an additive field. `end.reason`, `binary.format`,
 * `connection.state` and the foreground reasons are enumerated here, so a value outside the list
 * takes the whole frame down as `unrecognised-message` on the older side. Adding one is a
 * compatibility change: it has to be negotiated, the way a new opcode is, not shipped on the
 * strength of the reader dropping what it does not know.
 *
 * The two readers differ in more than their schema: the page's traffic is held to the document
 * caps, the shell's answers are not. `parseBridgeMessage` documents why.
 */
export const BRIDGE_PROTOCOL_VERSION = 1

/** Correlation ids are minted by whichever side opens the exchange; 22 chars is 128 bits of base64url. */
export const BRIDGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

const versionSchema = z.literal(BRIDGE_PROTOCOL_VERSION)
const idSchema = z.string().regex(BRIDGE_ID_PATTERN)
// Length only: the desktop's mobile-scope allowlist decides which names exist, and a charset guess
// here would refuse a method that allowlist already permits.
const methodSchema = z.string().min(1).max(BRIDGE_MAX_METHOD_CHARS)

/** Closed against `ConnectionState`; the pin lives in this module's test. */
export const BRIDGE_CONNECTION_STATES = [
  'connecting',
  'handshaking',
  'connected',
  'disconnected',
  'reconnecting',
  'auth-failed'
] as const

/** Closed against `BrowserScreencastFormat`; the pin lives in this module's test. */
export const BRIDGE_BINARY_FORMATS = ['jpeg', 'png'] as const

/** Closed against `ForegroundNudgeReason`; the pin lives in this module's test. */
export const BRIDGE_FOREGROUND_NUDGE_REASONS = ['focus', 'app-resume', 'network-change'] as const

/**
 * What the page's synchronous `RpcClient` getters read. It travels whole rather than as deltas so a
 * dropped frame cannot leave the cache half-applied, and `generation` is what lets the page notice
 * it missed one.
 */
export const BridgeConnectionSnapshotSchema = z.object({
  state: z.enum(BRIDGE_CONNECTION_STATES),
  reconnectAttempt: z.number().int().nonnegative(),
  lastConnectedAt: z.number().nullable(),
  // Null also covers the client not implementing the optional getter at all.
  lastInboundAt: z.number().nullable(),
  generation: z.number().int().nonnegative().nullable()
})

export type BridgeConnectionSnapshot = z.infer<typeof BridgeConnectionSnapshotSchema>

/** `native` is a list of grant names, empty in C0. Adding one is never a version bump. */
export const BridgeGrantsSchema = z.object({
  rpc: z.object({
    maxPendingRequests: z.number().int().positive(),
    maxSubscriptions: z.number().int().positive()
  }),
  native: z.array(z.string().min(1).max(64))
})

export type BridgeGrants = z.infer<typeof BridgeGrantsSchema>

/**
 * Which screen the shell opened this page for.
 *
 * Additive, and optional for that reason: a shell built before C1.2 sends no `route`, and the page
 * says so rather than painting expo-router's Unmatched screen. It has to cross, because the
 * document is served at `/` and refuses every other path, so the page's own location matches no
 * route in the tree it carries and there is nothing else to derive the screen from.
 *
 * `params` is the search half, kept out of `pathname` so neither side has to parse a URL: the page
 * builds one, once, and writes it into its history before the first render.
 */
export const BridgeInitRouteSchema = z.object({
  pathname: z
    .string()
    .min(1)
    .max(BRIDGE_MAX_ROUTE_PATHNAME_CHARS)
    .regex(BRIDGE_ROUTE_PATHNAME_PATTERN),
  params: z
    .record(
      z.string().min(1).max(BRIDGE_MAX_ROUTE_PARAM_CHARS),
      z.string().max(BRIDGE_MAX_ROUTE_PARAM_CHARS)
    )
    .refine((params) => Object.keys(params).length <= BRIDGE_MAX_ROUTE_PARAMS)
    .optional()
})

export type BridgeInitRoute = z.infer<typeof BridgeInitRouteSchema>

/**
 * The host the shell opened this page for, minus everything secret about it.
 *
 * `expo-secure-store` is `{}` on web, so the page's own `loadHosts()` answers with nothing and the
 * list paints "Host not found" over a host that is right there. What crosses is the profile the
 * screens read and not the credential they never touch: the bridge already carries the RPC, so a
 * page that held a device token would be holding one it has no use for.
 */
export const BridgeInitHostSchema = z.object({
  id: z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS),
  name: z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS),
  endpoint: z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS),
  lastConnected: z.number().finite()
})

export type BridgeInitHost = z.infer<typeof BridgeInitHostSchema>

/** The allowlisted keys as the app holds them right now. Absent keys are absent, never empty. */
export const BridgeInitStorageSchema = z
  .record(
    z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey),
    z.string().max(PAGE_STORAGE_MAX_VALUE_CHARS)
  )
  .refine((entries) => Object.keys(entries).length <= PAGE_STORAGE_MAX_ENTRIES)

/**
 * The one grant negotiated for the protocol itself rather than for a screen: the shell saying it
 * will act on a `fault` report.
 *
 * It exists because `notify` is a closed list on both sides. A page served by a newer desktop into
 * an older shell that posted an unknown name would have the whole frame refused as
 * `unrecognised-message`, so the page asks first and stays quiet when the answer is no.
 */
export const BRIDGE_FAULT_GRANT = 'fault'

/**
 * The `navigate` grant's second verb, and the first notify whose name is not its grant's.
 *
 * The page is served at `/` with one history entry written by `replaceState`, so its own Back goes
 * nowhere: the only stack to pop is the native one the shell pushed the page onto. It rides
 * `navigate` rather than a name of its own because an app that can open a screen can close one, and
 * a new grant name would leave every route that declares it native on every shell already shipped.
 */
export const BRIDGE_NAVIGATE_BACK_NOTIFY = 'navigate-back'

/**
 * The grant a page needs before the shell will open anything outside it.
 *
 * Its own name rather than a verb of `navigate`, because it is a different capability: `navigate`
 * opens a screen this app carries, and this hands a URL to whatever the device opens it with. A
 * shell that implements one and not the other is a real shell, and the route policy has to be able
 * to say so.
 */
export const BRIDGE_EXTERNAL_LINK_GRANT = 'externalLink'

/** Pinned against `SendRequestOptions` in this module's test. */
export const BridgeSendRequestOptionsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  budgetSpansConnect: z.boolean().optional(),
  failWhenDisconnected: z.boolean().optional()
})

/**
 * A host `RpcFailure` is data, not a rejection: it rides in `reply` exactly as it arrived, `_meta`
 * and `error.data` included, because the page reads it and the goldens record it. Nothing is
 * stripped for the same reason — a field a newer host adds must reach the page unaltered.
 *
 * The predicate is the native client's own, imported rather than restated. A page reader narrower
 * than the transport it stands in for refuses replies the phone accepts today: `_meta` is required
 * on neither arm off the wire, and `src/shared/runtime-rpc-envelope.ts` makes it optional on a
 * failure with a nullable `runtimeId`. Widening a reader is safe in both directions; keeping a
 * second copy of one is what drifts.
 */
export const BridgeReplyPayloadSchema = z.custom<RpcResponse>(isRpcResponse)

/**
 * `BrowserScreencastFrameMetadata` field for field, loose so a field a newer host adds still reaches
 * the page. Every value is a finite number there, which is what `z.number()` accepts.
 */
const screencastMetadataSchema = z.looseObject({
  offsetTop: z.number().optional(),
  pageScaleFactor: z.number().optional(),
  deviceWidth: z.number().optional(),
  deviceHeight: z.number().optional(),
  imageWidth: z.number().optional(),
  imageHeight: z.number().optional(),
  scrollOffsetX: z.number().optional(),
  scrollOffsetY: z.number().optional(),
  timestamp: z.number().optional()
})

const replyPartSchema = z.object({
  i: z
    .number()
    .int()
    .nonnegative()
    .max(BRIDGE_MAX_REPLY_PARTS - 1),
  of: z.number().int().positive().max(BRIDGE_MAX_REPLY_PARTS)
})

const BridgeClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ v: versionSchema, type: z.literal('ready') }),
  z.object({
    v: versionSchema,
    type: z.literal('request'),
    id: idSchema,
    method: methodSchema,
    // Absent stays absent: `sendRequest(method)` and `sendRequest(method, undefined)` are different
    // calls to the recorder, so the host replays the arity the page used.
    params: z.unknown().optional(),
    options: BridgeSendRequestOptionsSchema.optional()
  }),
  z.object({
    v: versionSchema,
    type: z.literal('subscribe'),
    id: idSchema,
    method: methodSchema,
    params: z.unknown(),
    wantsBinary: z.boolean().optional()
  }),
  z.object({
    v: versionSchema,
    type: z.literal('cancel'),
    id: idSchema,
    target: z.enum(['request', 'subscription'])
  }),
  z.object({
    v: versionSchema,
    type: z.literal('ack'),
    id: idSchema,
    seq: z.number().int().nonnegative()
  }),
  z.discriminatedUnion('name', [
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal('foreground'),
      reason: z.enum(BRIDGE_FOREGROUND_NUDGE_REASONS).optional()
    }),
    // Behind the `navigate` grant, and that is not a convention: this union is closed, so an older
    // shell refuses the whole frame as `unrecognised-message`. The page checks `grants.native`
    // before it posts, which is what a grant is for.
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal('navigate'),
      href: z.string().min(1).max(BRIDGE_MAX_ROUTE_HREF_CHARS).regex(BRIDGE_ROUTE_HREF_PATTERN)
    }),
    // Behind the same `navigate` grant, and carrying no target: the shell pops what it pushed, and
    // a page naming where to go back to would be naming a screen it cannot see.
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal(BRIDGE_NAVIGATE_BACK_NOTIFY)
    }),
    // Behind the `externalLink` grant. The URL is held to the same three schemes on both sides: the
    // page refuses at the call site so a tap knows it went nowhere, and this refuses the frame so a
    // page that did not check is still held to it.
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal(BRIDGE_EXTERNAL_LINK_GRANT),
      url: z.string().min(1).max(BRIDGE_MAX_EXTERNAL_LINK_CHARS).refine(isBridgeExternalLinkUrl)
    }),
    // Behind the `storage` grant, for the same reason `navigate` is behind its own.
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal('storage'),
      key: z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey),
      /** Null removes it, which is what `AsyncStorage.removeItem` does. */
      value: z.string().max(PAGE_STORAGE_MAX_VALUE_CHARS).nullable()
    }),
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal('terminalViewport'),
      terminal: z.string().min(1),
      cols: z.number().int().min(1).max(BRIDGE_MAX_VIEWPORT_COLS),
      rows: z.number().int().min(1).max(BRIDGE_MAX_VIEWPORT_ROWS)
    }),
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal(BRIDGE_FAULT_GRANT),
      /** The capture an `error` frame already carries, so both directions share one bound and one
       *  reader. Nothing is owed back: the page is telling the shell, not asking it. */
      error: BridgeErrorCaptureSchema
    }),
    // Behind the `haptics` grant, and the fields are its own module's for the reason stated there.
    z.object({ v: versionSchema, ...BRIDGE_HAPTICS_NOTIFY_FIELDS })
  ]),
  z.object({ v: versionSchema, type: z.literal('close') })
])

export type BridgeClientMessage = z.infer<typeof BridgeClientMessageSchema>

// Not a discriminated union: `reply` and `event` each have two shapes under one `type`, which zod's
// discriminator cannot express. Hot frames come first so the common case matches on the first try.
const BridgeHostMessageSchema = z.union([
  z.object({
    v: versionSchema,
    type: z.literal('event'),
    id: idSchema,
    seq: z.number().int().nonnegative(),
    payload: z.unknown()
  }),
  z.object({
    v: versionSchema,
    type: z.literal('event'),
    id: idSchema,
    seq: z.number().int().nonnegative(),
    // A binary listener is handed a decoded `BrowserScreencastFrame`, never bytes, so every field
    // but the image crosses beside the base64. `seq` is the bridge's backpressure counter;
    // `frameSeq` is the screencast's own, and conflating them loses one of the two.
    binary: z.object({
      b64: z.string(),
      format: z.enum(BRIDGE_BINARY_FORMATS),
      frameSeq: z.number().int().nonnegative(),
      metadata: screencastMetadataSchema
    })
  }),
  z.object({
    v: versionSchema,
    type: z.literal('reply'),
    id: idSchema,
    payload: BridgeReplyPayloadSchema
  }),
  z.object({
    v: versionSchema,
    type: z.literal('reply'),
    id: idSchema,
    part: replyPartSchema,
    chunk: z.string()
  }),
  z.object({
    v: versionSchema,
    type: z.literal('state'),
    connection: BridgeConnectionSnapshotSchema
  }),
  z.object({
    v: versionSchema,
    type: z.literal('end'),
    id: idSchema,
    reason: z.enum(['unsubscribed', 'closed', 'overflow'])
  }),
  z.object({
    v: versionSchema,
    type: z.literal('error'),
    id: idSchema,
    error: BridgeErrorCaptureSchema
  }),
  z.object({
    v: versionSchema,
    type: z.literal('init'),
    sessionId: z.string().min(1),
    buildId: z.string().min(1),
    connection: BridgeConnectionSnapshotSchema,
    grants: BridgeGrantsSchema,
    route: BridgeInitRouteSchema.optional(),
    host: BridgeInitHostSchema.optional(),
    storage: BridgeInitStorageSchema.optional(),
    /** Every route pattern the shell would render from the page. The page keeps a navigation into
     *  one of them and hands the rest back, which is the only thing that tells it which is which. */
    pageRoutes: z
      .array(z.string().min(1).max(BRIDGE_MAX_ROUTE_PATHNAME_CHARS))
      .max(BRIDGE_MAX_PAGE_ROUTES)
      .optional(),
    /**
     * What each of those patterns declared, so the page can tell a hop it may keep from one it must
     * hand back.
     *
     * `pageRoutes` says which routes this shell would render; it does not say what each costs. A
     * page keeping a push local on the pattern alone runs the target under the opener's grants,
     * which is how the tasks page was reached from the sidebar without `native.clipboard.write`.
     *
     * Optional in both directions: an older shell omits it and the page falls back to today's
     * behaviour, an older page ignores it. The grant grammar is the manifest's own, so a name the
     * bundle could not have declared cannot arrive here either.
     */
    pageRouteGrants: BridgePageRouteGrantsSchema.optional()
  })
])

export type BridgeHostMessage = z.infer<typeof BridgeHostMessageSchema>
export type BridgeReplyMessage = Extract<BridgeHostMessage, { type: 'reply' }>
export type BridgeReplyPayload = z.infer<typeof BridgeReplyPayloadSchema>

/**
 * The exchange a frame the page's reader refused was answering, when it named one.
 *
 * A refused frame is dropped, and a dropped `reply` or `error` would otherwise leave the request it
 * answered pending for the life of the document. The id is salvaged through the same caps the
 * reader applies, never trusted: the caller settles only an exchange it already holds, so a frame
 * naming anything else still changes nothing.
 *
 * Two refusals are decided before an id can exist: `oversized`, on the raw string, and
 * `malformed-json`, on a parse that did not finish. Nothing is salvageable from either, so an
 * exchange one of those frames was answering is settled by `close` or by a shell replacement and by
 * nothing else. Neither arises from a host that is behaving: it chunks at the frame cap and refuses
 * a body over `BRIDGE_MAX_REPLY_BYTES` on its own side, answering with an `error` frame instead.
 */
export function readRefusedBridgeFrameId(raw: string): string | null {
  const framed = parseBridgeMessage(raw, 'shell-to-page')
  if (!framed.ok) {
    return null
  }
  const frame = framed.message
  if (typeof frame !== 'object' || frame === null || !('id' in frame)) {
    return null
  }
  const { id } = frame
  return typeof id === 'string' && BRIDGE_ID_PATTERN.test(id) ? id : null
}

/** What the RN host accepts from the page. */
export function readBridgeClientMessage(raw: string): BridgeRead<BridgeClientMessage> {
  return readMessage(raw, BridgeClientMessageSchema, 'page-to-shell')
}

/** What the page accepts from the RN host. */
export function readBridgeHostMessage(raw: string): BridgeRead<BridgeHostMessage> {
  return readMessage(raw, BridgeHostMessageSchema, 'shell-to-page')
}

function readMessage<TMessage>(
  raw: string,
  schema: z.ZodType<TMessage>,
  direction: BridgeDirection
): BridgeRead<TMessage> {
  const framed = parseBridgeMessage(raw, direction)
  if (!framed.ok) {
    return framed
  }
  const parsed = schema.safeParse(framed.message)
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, refusal: 'unrecognised-message' }
}
