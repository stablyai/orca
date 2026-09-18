import { z } from 'zod'
import { isRpcResponse } from '../../transport/rpc-response-shape'
import type { RpcResponse } from '../../transport/types'
import { BridgeErrorCaptureSchema } from './bridge-error-capture'
import {
  BRIDGE_MAX_METHOD_CHARS,
  BRIDGE_MAX_REPLY_PARTS,
  BRIDGE_MAX_VIEWPORT_COLS,
  BRIDGE_MAX_VIEWPORT_ROWS,
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
    z.object({
      v: versionSchema,
      type: z.literal('notify'),
      name: z.literal('terminalViewport'),
      terminal: z.string().min(1),
      cols: z.number().int().min(1).max(BRIDGE_MAX_VIEWPORT_COLS),
      rows: z.number().int().min(1).max(BRIDGE_MAX_VIEWPORT_ROWS)
    })
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
    grants: BridgeGrantsSchema
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
