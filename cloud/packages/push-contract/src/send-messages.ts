import { z } from 'zod'
import {
  PushAgentStateSchema,
  PushNotificationSourceSchema
} from './device-registration-messages.js'
import { PUSH_LIMITS } from './push-limits.js'
import { OpaqueIdSchema, SequenceSchema } from './wire-scalars.js'

export const PushNotificationSchema = z
  .object({
    // Absent for terminal-bell, which the desktop raises without a notification record.
    // Printable ASCII only: the id becomes the APNs collapse header, and the
    // desktop builds it from URL-encoded parts, so anything else is not Orca's.
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
    kind: z.enum(['alert', 'dismiss']).optional(),
    expiresAt: z.number().int().positive().optional(),
    agentState: PushAgentStateSchema.nullable(),
    title: z.string().min(1).max(PUSH_LIMITS.titleMaxChars),
    body: z.string().max(PUSH_LIMITS.bodyMaxChars),
    worktreeId: z.string().min(1).max(2048).optional()
  })
  .strict()
  .refine(
    (notification) => notification.kind !== 'dismiss' || Boolean(notification.notificationId),
    { message: 'dismiss requires notificationId' }
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
