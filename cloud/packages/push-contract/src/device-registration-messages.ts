import { z } from 'zod'
import { OpaqueIdSchema } from './wire-scalars.js'

export const PushPlatformSchema = z.enum(['ios', 'android'])
export const ApnsEnvironmentSchema = z.enum(['sandbox', 'production'])
export const PushNotificationSourceSchema = z.enum([
  'agent-task-complete',
  'terminal-bell',
  'plugin'
])
export const PushAgentStateSchema = z.enum(['needs-input', 'finished'])

// APNs tokens are variable-length byte strings, including longer simulator tokens.
const APNS_TOKEN_PATTERN = /^(?:[0-9a-fA-F]{2})+$/
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.\-]{32,4096}$/

export const PushDeviceRegistrationRequestSchema = z
  .object({
    v: z.literal(1),
    deviceId: OpaqueIdSchema,
    platform: PushPlatformSchema,
    token: z.string().min(1).max(4096),
    apnsEnvironment: ApnsEnvironmentSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.platform === 'ios') {
      if (value.apnsEnvironment === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['apnsEnvironment'],
          message: 'apnsEnvironment is required for ios'
        })
      }
      if (!APNS_TOKEN_PATTERN.test(value.token)) {
        context.addIssue({
          code: 'custom',
          path: ['token'],
          message: 'ios token must be hex-encoded bytes'
        })
      }
      return
    }
    if (value.apnsEnvironment !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['apnsEnvironment'],
        message: 'apnsEnvironment is ios only'
      })
    }
    if (!FCM_TOKEN_PATTERN.test(value.token)) {
      context.addIssue({
        code: 'custom',
        path: ['token'],
        message: 'android token must be an FCM registration string'
      })
    }
  })

export const PushDeviceSummarySchema = z
  .object({
    registrationId: OpaqueIdSchema,
    deviceId: OpaqueIdSchema,
    platform: PushPlatformSchema,
    dead: z.boolean()
  })
  .strict()

export type PushPlatform = z.infer<typeof PushPlatformSchema>
export type ApnsEnvironment = z.infer<typeof ApnsEnvironmentSchema>
export type PushNotificationSource = z.infer<typeof PushNotificationSourceSchema>
export type PushAgentState = z.infer<typeof PushAgentStateSchema>
export type PushDeviceRegistrationRequest = z.infer<typeof PushDeviceRegistrationRequestSchema>
export type PushDeviceSummary = z.infer<typeof PushDeviceSummarySchema>
