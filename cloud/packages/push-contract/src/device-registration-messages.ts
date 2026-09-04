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

const APNS_TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.\-]{32,4096}$/

export const PushNotificationFilterSchema = z
  .object({
    sources: z.array(PushNotificationSourceSchema).max(3),
    agentStates: z.array(PushAgentStateSchema).max(2)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.sources).size !== value.sources.length) {
      context.addIssue({ code: 'custom', path: ['sources'], message: 'sources must be unique' })
    }
    if (new Set(value.agentStates).size !== value.agentStates.length) {
      context.addIssue({
        code: 'custom',
        path: ['agentStates'],
        message: 'agentStates must be unique'
      })
    }
  })

export const PushDeviceRegistrationRequestSchema = z
  .object({
    v: z.literal(1),
    deviceId: OpaqueIdSchema,
    platform: PushPlatformSchema,
    token: z.string().min(1).max(4096),
    apnsEnvironment: ApnsEnvironmentSchema.optional(),
    filter: PushNotificationFilterSchema
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
        context.addIssue({ code: 'custom', path: ['token'], message: 'ios token must be 64 hex' })
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

export const PushDeviceRegistrationResponseSchema = z
  .object({ registrationId: OpaqueIdSchema })
  .strict()

export const PushDeviceSummarySchema = z
  .object({
    registrationId: OpaqueIdSchema,
    deviceId: OpaqueIdSchema,
    platform: PushPlatformSchema,
    dead: z.boolean()
  })
  .strict()

export const PushDeviceListResponseSchema = z
  .object({ devices: z.array(PushDeviceSummarySchema).max(1024) })
  .strict()

export type PushPlatform = z.infer<typeof PushPlatformSchema>
export type ApnsEnvironment = z.infer<typeof ApnsEnvironmentSchema>
export type PushNotificationSource = z.infer<typeof PushNotificationSourceSchema>
export type PushAgentState = z.infer<typeof PushAgentStateSchema>
export type PushNotificationFilter = z.infer<typeof PushNotificationFilterSchema>
export type PushDeviceRegistrationRequest = z.infer<typeof PushDeviceRegistrationRequestSchema>
export type PushDeviceSummary = z.infer<typeof PushDeviceSummarySchema>
