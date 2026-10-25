import { z } from 'zod'
import { salvagedOptional } from '../../../../src/shared/zod-salvage'
import { NODE_PLATFORM_NAMES } from '../../transport/mobile-runtime-host-platform'
import { RpcEnvelopeFieldsSchema } from '../../transport/rpc-envelope-fields'
import { isRpcResponse } from '../../transport/rpc-response-shape'
import type { RpcResponse } from '../../transport/types'
import { BridgeErrorCaptureSchema } from './bridge-error-capture'
import { BridgeInitRouteSchema, type BridgeInitRoute } from './bridge-init-route'
import { BridgePageRouteGrantsSchema } from './bridge-page-route-grants'
import { BridgeSafeAreaInsetsSchema } from './bridge-safe-area-insets'
import { BridgeKeyboardInsetSchema } from './bridge-keyboard-inset'
import { BridgeNotifySchema } from './bridge-notify-envelope'
import { BRIDGE_BACK_FRAME } from './bridge-page-back'
import { BRIDGE_ID_PATTERN, idSchema, methodSchema, versionSchema } from './bridge-frame-fields'

export {
  BRIDGE_EXTERNAL_LINK_GRANT,
  BRIDGE_FAULT_GRANT,
  BRIDGE_FOREGROUND_NUDGE_REASONS,
  BRIDGE_ID_PATTERN,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RPC_ENVELOPE_GRANT
} from './bridge-frame-fields'
import {
  isPageStorageKey,
  PAGE_STORAGE_MAX_ENTRIES,
  PAGE_STORAGE_MAX_KEY_CHARS,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../page-storage-keys'
import {
  BRIDGE_MAX_PAGE_ROUTES,
  BRIDGE_MAX_REPLY_PARTS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_MAX_HOST_FIELD_CHARS,
  parseBridgeMessage,
  type BridgeDirection,
  type BridgeRead
} from './bridge-caps'

export const BRIDGE_CONNECTION_STATES = [
  'connecting',
  'handshaking',
  'connected',
  'disconnected',
  'reconnecting',
  'auth-failed'
] as const

export const BRIDGE_BINARY_FORMATS = ['jpeg', 'png'] as const

// Send whole connection snapshots so lost frames cannot leave partial state; generation detects snapshots that need repair.
export const BridgeConnectionSnapshotSchema = z.object({
  state: z.enum(BRIDGE_CONNECTION_STATES),
  reconnectAttempt: z.number().int().nonnegative(),
  lastConnectedAt: z.number().nullable(),
  lastInboundAt: z.number().nullable(),
  generation: z.number().int().nonnegative().nullable()
})

export type BridgeConnectionSnapshot = z.infer<typeof BridgeConnectionSnapshotSchema>

export const BridgeGrantsSchema = z.object({
  rpc: z.object({
    maxPendingRequests: z.number().int().positive(),
    maxSubscriptions: z.number().int().positive()
  }),
  native: z.array(z.string().min(1).max(64))
})

export type BridgeGrants = z.infer<typeof BridgeGrantsSchema>

export { BridgeInitRouteSchema, type BridgeInitRoute }

// Forward only nonsecret host profile fields: web SecureStore is empty, but the bridge already owns credentials/RPC and the page needs host labels to render.
export const BridgeInitHostSchema = z.object({
  id: z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS),
  name: z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS),
  // Optional name metadata distinguishes phone overrides from desktop names; salvage unknown platform values so newer shells cannot invalidate the whole init.
  // The outer optional keeps the key optional, rather than requiring a T|undefined property.
  personalName: salvagedOptional(
    'personalName',
    z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS)
  ).optional(),
  lastKnownMachineName: salvagedOptional(
    'lastKnownMachineName',
    z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS)
  ).optional(),
  lastKnownHostPlatform: salvagedOptional(
    'lastKnownHostPlatform',
    z.enum(NODE_PLATFORM_NAMES)
  ).optional(),
  endpoint: z.string().min(1).max(BRIDGE_MAX_HOST_FIELD_CHARS),
  lastConnected: z.number().finite()
})

export type BridgeInitHost = z.infer<typeof BridgeInitHostSchema>

export const BridgeInitStorageSchema = z
  .record(
    z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey),
    z.string().max(PAGE_STORAGE_MAX_VALUE_CHARS)
  )
  .refine((entries) => Object.keys(entries).length <= PAGE_STORAGE_MAX_ENTRIES)

export const BridgeSendRequestOptionsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  budgetSpansConnect: z.boolean().optional(),
  failWhenDisconnected: z.boolean().optional()
})

// Reuse native isRpcResponse and preserve failures as data, including _meta/error.data and new fields; a narrower bridge reader would reject replies native clients and golden recorders accept.
export const BridgeReplyPayloadSchema = z.custom<RpcResponse>(isRpcResponse)

// Keep screencast metadata loose for newer host fields; z.number accepts the same finite-number values as the host type.
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
    type: z.literal('ready')
  }),
  z.object({
    v: versionSchema,
    type: z.literal('request'),
    id: idSchema,
    method: methodSchema,
    params: z.unknown().optional(),
    options: BridgeSendRequestOptionsSchema.optional(),
    envelope: RpcEnvelopeFieldsSchema.optional()
  }),
  z.object({
    v: versionSchema,
    type: z.literal('subscribe'),
    id: idSchema,
    method: methodSchema,
    params: z.unknown(),
    wantsBinary: z.boolean().optional(),
    envelope: RpcEnvelopeFieldsSchema.optional()
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

// reply/event each have multiple shapes under type, so use a union rather than a discriminator; try hot frames first.
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
    // Carry decoded-frame metadata alongside base64. Keep bridge seq separate from screencast frameSeq: only the former drives backpressure.
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
  // Back names no destination; only the native stack knows what screen lies beneath.
  z.object({ v: versionSchema, type: z.literal(BRIDGE_BACK_FRAME) }),
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
    safeAreaInsets: BridgeSafeAreaInsetsSchema.optional(),
    keyboardInset: BridgeKeyboardInsetSchema.optional(),
    host: BridgeInitHostSchema.optional(),
    storage: BridgeInitStorageSchema.optional(),
    // Advisory page fast path for oversized keys; the shell independently refuses writes because older pages ignore this additive field (ruling 33.6).
    storageOversize: z
      .array(z.string().min(1).max(PAGE_STORAGE_MAX_KEY_CHARS).refine(isPageStorageKey))
      .max(PAGE_STORAGE_MAX_ENTRIES)
      .optional(),
    pageRoutes: z
      .array(z.string().min(1).max(BRIDGE_MAX_ROUTE_PATHNAME_CHARS))
      .max(BRIDGE_MAX_PAGE_ROUTES)
      .optional(),
    // Send manifest grant pairs so local hops cannot run targets under insufficient opener grants. Older shells omit/older pages ignore this field; absent pairs retain the older handoff rule.
    pageRouteGrants: BridgePageRouteGrantsSchema.optional(),
    ownsHostArea: salvagedOptional('ownsHostArea', z.boolean()).optional()
  })
])

export type BridgeHostMessage = z.infer<typeof BridgeHostMessageSchema>
export type BridgeReplyMessage = Extract<BridgeHostMessage, { type: 'reply' }>
export type BridgeReplyPayload = z.infer<typeof BridgeReplyPayloadSchema>

// Salvage a refused frame’s id through the same caps to settle only an existing exchange; silently dropping replies would strand requests.
// Raw oversize and malformed JSON yield no id, so only close/replacement settles their exchanges; conforming hosts instead chunk or send bounded errors.
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

export function readBridgeClientMessage(raw: string): BridgeRead<BridgeClientMessage> {
  return readMessage(raw, BridgeClientMessageSchema, 'page-to-shell')
}

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
