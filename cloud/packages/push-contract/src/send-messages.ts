import { z } from 'zod'
import {
  PushAgentStateSchema,
  PushNotificationSourceSchema
} from './device-registration-messages.js'
import { PUSH_LIMITS } from './push-limits.js'
import { OpaqueIdSchema, SequenceSchema } from './wire-scalars.js'

export const PushNotificationSchema = z
  .object({
    // Absent for terminal-bell; printable ASCII only because desktop URL-encoded IDs become APNs collapse headers.
    notificationId: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[\x20-\x7e]+$/)
      .optional(),
    notificationSeq: SequenceSchema,
    notificationEpoch: OpaqueIdSchema,
    source: PushNotificationSourceSchema,
    sound: z.boolean().optional(),
    kind: z.enum(['alert', 'dismiss', 'badge']).optional(),
    // The sending host's unread count; the gateway sums every host's for one phone.
    badge: z.number().int().nonnegative().max(PUSH_LIMITS.maxBadgeCount).optional(),
    expiresAt: z.number().int().positive().optional(),
    agentState: PushAgentStateSchema.nullable(),
    title: z.string().min(1).max(PUSH_LIMITS.titleMaxChars),
    body: z.string().max(PUSH_LIMITS.bodyMaxChars),
    worktreeId: z.string().min(1).max(2048).optional(),
    paneKey: z.string().min(1).max(2048).optional(),
    // The workspace's server; mirrors the app's runtime host id (cannot import src/shared).
    category: z.literal('orca.reply').optional(),
    replyTarget: z.discriminatedUnion('type', [
      z.object({ type: z.literal('terminal'), terminal: z.string().min(1).max(2048), expectedIncarnationId: z.string().min(1).max(2048) }).strict(),
      z.object({ type: z.literal('chat'), sessionId: z.string().min(1).max(256) }).strict(),
        z.object({ type: z.literal('bot-item'), itemUid: z.string().min(1).max(256) }).strict(),
        z.object({ type: z.literal('group'), groupId: z.string().min(1).max(256) }).strict()
    ]).optional(),
    executionHost: z
      .string()
      .max(2048)
      .regex(/^runtime:[^|\s]+$/)
      .optional()
  })
  .strict()
  .refine((n) => n.replyTarget === undefined ||
    ((n.kind === undefined || n.kind === 'alert') && Boolean(n.worktreeId && n.paneKey) && n.category === 'orca.reply'),
    { message: 'reply requires a chat alert and category' })
  .refine((n) => n.category !== 'orca.reply' || n.replyTarget !== undefined,
    { message: 'reply category requires a target' })
  .refine(
    (notification) => notification.kind !== 'dismiss' || Boolean(notification.notificationId),
    { message: 'dismiss requires notificationId' }
  )
  .refine(
    (notification) => (notification.kind === 'badge') === (notification.badge !== undefined),
    { message: 'badge is sent with the badge kind only' }
  )
  .refine(
    (notification) => new TextEncoder().encode(JSON.stringify(notification)).byteLength <= 3000,
    {
      message: 'notification exceeds provider payload budget'
    }
  )

export const PushSendRequestSchema = z
  .object({
    v: z.literal(1),
    // Deduped before the gateway sees it so a repeated id cannot reserve quota twice.
    registrationIds: z
      .array(OpaqueIdSchema)
      .min(1)
      .max(PUSH_LIMITS.maxRegistrationIdsPerSend)
      .transform((ids) => [...new Set(ids)]),
    notification: PushNotificationSchema
  })
  .strict()

export const PushSendStatusSchema = z.enum(['queued', 'dead', 'rate_limited', 'error'])

export const PushSendResultSchema = z
  .object({ registrationId: OpaqueIdSchema, status: PushSendStatusSchema })
  .strict()

export type PushNotification = z.infer<typeof PushNotificationSchema>
export type PushSendRequest = z.infer<typeof PushSendRequestSchema>
export type PushSendStatus = z.infer<typeof PushSendStatusSchema>
export type PushSendResult = z.infer<typeof PushSendResultSchema>
