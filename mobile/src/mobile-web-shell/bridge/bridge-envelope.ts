import { z } from 'zod'
import { isRpcResponse } from '../../transport/rpc-response-shape'
import type { RpcResponse } from '../../transport/types'
import { BridgeErrorCaptureSchema } from './bridge-error-capture'
import { BridgeInitRouteSchema, type BridgeInitRoute } from './bridge-init-route'
import { BridgePageRouteGrantsSchema } from './bridge-page-route-grants'
import { BridgeNotifySchema } from './bridge-notify-envelope'
import { BRIDGE_ID_PATTERN, idSchema, methodSchema, versionSchema } from './bridge-frame-fields'

export {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_FOREGROUND_NUDGE_REASONS,
  BRIDGE_ID_PATTERN,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION
} from './bridge-frame-fields'
import {
  isPageStorageKey,
  PAGE_STORAGE_MAX_ENTRIES,
  PAGE_STORAGE_MAX_KEY_CHARS,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../page-storage-keys'
import {
  BRIDGE_MAX_PAGE_ACCEPT_CHARS,
  BRIDGE_MAX_PAGE_ACCEPTS,
  BRIDGE_MAX_PAGE_ROUTES,
  BRIDGE_MAX_REPLY_PARTS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_MAX_HOST_FIELD_CHARS,
  parseBridgeMessage,
  type BridgeDirection,
  type BridgeRead
} from './bridge-caps'

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

// The route half of `init`, in its own module; re-exported so the envelope stays one import for
// everything that reads a bridge frame.
export { BridgeInitRouteSchema, type BridgeInitRoute }

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
  z.object({
    v: versionSchema,
    type: z.literal('ready'),
    /**
     * What this page can be sent beyond its first `init`; the names and why live in
     * `bridge-route-update.ts`, which is the only one there is.
     *
     * Optional, and safe in both directions without a version bump: a page that sends none is
     * never sent a second `init`, and a shell that reads none never sends one. An unknown name is
     * accepted by the schema and ignored by the shell, which is what a newer page declaring a
     * capability this shell has never implemented has to look like.
     */
    accepts: z
      .array(z.string().min(1).max(BRIDGE_MAX_PAGE_ACCEPT_CHARS))
      .max(BRIDGE_MAX_PAGE_ACCEPTS)
      .optional(),
    /**
     * What this page will post that the shell may have to wait for, which today is
     * `BRIDGE_PAGE_PAINTED` and nothing else.
     *
     * `accepts` runs the other way and cannot stand in for this: it says what may be sent *to* the
     * page. A shell waiting on a frame has to know the page will send one, because the generation
     * is served by a desktop that updates independently of the installed shell — an undeclared
     * wait would hide a working page built before the frame existed.
     *
     * Optional and additive in both directions, on the same bounds as `accepts`: a page that
     * declares none is waited for by nothing, and an unknown name is a report this shell does not
     * act on.
     */
    reports: z
      .array(z.string().min(1).max(BRIDGE_MAX_PAGE_ACCEPT_CHARS))
      .max(BRIDGE_MAX_PAGE_ACCEPTS)
      .optional()
  }),
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
  BridgeNotifySchema,
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
    /**
     * The allowlisted keys the shell holds a value for that `storage` could not carry, because the
     * app's value is over the page's own cap (ruling 33.6).
     *
     * Advisory, not the enforcement. The shell refuses a write to one of these on its own side
     * too, because a page served from an older desktop bundle ignores this field entirely and
     * would still replace what the device holds; this is the page's fast path, so a write it can
     * refuse locally rejects without a round trip and reaches its caller as `too-large`.
     *
     * Optional and additive: an older shell sends none and an older page ignores it. Bounded by
     * the same count as the storage record, since it names a subset of the same keys.
     */
    storageOversize: z
      .array(z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey))
      .max(PAGE_STORAGE_MAX_ENTRIES)
      .optional(),
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
    pageRouteGrants: BridgePageRouteGrantsSchema.optional(),
    /**
     * What this shell accepts from the page beyond the frames every shell has always taken, which
     * today is `BRIDGE_ROUTE_PARAM_CLEAR` and nothing else.
     *
     * The mirror of `ready.accepts`, and optional for the same reason: a shell that sends none is
     * never posted a clear, and a page that reads none never posts one. An unknown name is a
     * capability this page has never heard of and is ignored.
     */
    accepts: z
      .array(z.string().min(1).max(BRIDGE_MAX_PAGE_ACCEPT_CHARS))
      .max(BRIDGE_MAX_PAGE_ACCEPTS)
      .optional()
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
