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
    notificationId: z.string().min(1).max(256).optional(),
    notificationSeq: SequenceSchema,
    notificationEpoch: OpaqueIdSchema,
    source: PushNotificationSourceSchema,
    agentState: PushAgentStateSchema.nullable(),
    title: z.string().min(1).max(PUSH_LIMITS.titleMaxChars),
    body: z.string().max(PUSH_LIMITS.bodyMaxChars),
    worktreeId: z.string().min(1).max(256).optional()
  })
  .strict()

export const PushSendRequestSchema = z
  .object({
    v: z.literal(1),
    // Deduped before the gateway sees it: a repeated id would otherwise reserve
    // quota twice and inflate the coalesced count for one banner.
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

export const PushSendResponseSchema = z
  .object({
    results: z.array(PushSendResultSchema).max(PUSH_LIMITS.maxRegistrationIdsPerSend)
  })
  .strict()

export type PushNotification = z.infer<typeof PushNotificationSchema>
export type PushSendRequest = z.infer<typeof PushSendRequestSchema>
export type PushSendStatus = z.infer<typeof PushSendStatusSchema>
export type PushSendResult = z.infer<typeof PushSendResultSchema>
export type PushSendResponse = z.infer<typeof PushSendResponseSchema>
