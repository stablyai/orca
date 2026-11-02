import { z } from 'zod'
import { Base64Url32ByteSchema, EpochMsSchema, OpaqueIdSchema } from './wire-scalars.js'

export const RelayAuthSchema = z
  .object({ v: z.literal(1), mode: z.literal('connect'), credential: Base64Url32ByteSchema })
  .strict()

const RelayErrorCodeSchema = z.union([
  z.literal(4401),
  z.literal(4404),
  z.literal(4408),
  z.literal(4409),
  z.literal(4429),
  z.literal(4503)
])

export const RelayHelloSchema = z.union([
  z.object({ ok: z.literal(false), code: RelayErrorCodeSchema }).strict(),
  z
    .object({
      ok: z.literal(true),
      credentialKind: z.literal('invite'),
      leaseExpiresAt: EpochMsSchema
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      credentialKind: z.literal('resume'),
      leaseExpiresAt: EpochMsSchema,
      acceptedCredentialVersion: z.number().int().positive(),
      acceptedAs: z.enum(['current', 'grace']),
      resumeExpiresAt: EpochMsSchema,
      graceExpiresAt: EpochMsSchema.optional()
    })
    .strict()
])

export const DeviceCredentialInstallSchema = z
  .object({
    v: z.literal(1),
    reqId: OpaqueIdSchema,
    relayDeviceId: OpaqueIdSchema,
    newResumeTokenHash: Base64Url32ByteSchema,
    expectedCurrentHash: Base64Url32ByteSchema.optional(),
    authorization: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('relay-basis'), basisConnId: OpaqueIdSchema }).strict(),
      z.object({ mode: z.literal('authenticated-direct'), directAuthId: OpaqueIdSchema }).strict()
    ])
  })
  .strict()

export const DeviceCredentialInstallStatusSchema = z
  .object({ v: z.literal(1), reqId: OpaqueIdSchema, relayDeviceId: OpaqueIdSchema })
  .strict()

export const DeviceResumeConfirmSchema = z
  .object({ v: z.literal(1), reqId: OpaqueIdSchema, basisConnId: OpaqueIdSchema })
  .strict()

export const DeviceCredentialInstalledSchema = z
  .object({
    v: z.literal(1),
    reqId: OpaqueIdSchema,
    authorizationMode: z.enum(['relay-basis', 'authenticated-direct']),
    currentVersion: z.number().int().positive(),
    resumeExpiresAt: EpochMsSchema,
    graceExpiresAt: EpochMsSchema.optional()
  })
  .strict()

export const DeviceCredentialInstallStatusResultSchema = z.union([
  z.object({ v: z.literal(1), reqId: OpaqueIdSchema, state: z.literal('not-found') }).strict(),
  z
    .object({
      v: z.literal(1),
      reqId: OpaqueIdSchema,
      state: z.literal('committed'),
      result: DeviceCredentialInstalledSchema
    })
    .strict()
])

export const DeviceResumeConfirmedSchema = z
  .object({
    v: z.literal(1),
    reqId: OpaqueIdSchema,
    currentVersion: z.number().int().positive(),
    acceptedAs: z.enum(['current', 'grace']),
    renewed: z.boolean(),
    resumeExpiresAt: EpochMsSchema,
    graceExpiresAt: EpochMsSchema.optional()
  })
  .strict()

export type RelayAuth = z.infer<typeof RelayAuthSchema>
export type RelayHello = z.infer<typeof RelayHelloSchema>
export type DeviceCredentialInstall = z.infer<typeof DeviceCredentialInstallSchema>
export type DeviceCredentialInstalled = z.infer<typeof DeviceCredentialInstalledSchema>
export type DeviceCredentialInstallStatus = z.infer<typeof DeviceCredentialInstallStatusSchema>
export type DeviceCredentialInstallStatusResult = z.infer<
  typeof DeviceCredentialInstallStatusResultSchema
>
export type DeviceResumeConfirm = z.infer<typeof DeviceResumeConfirmSchema>
export type DeviceResumeConfirmed = z.infer<typeof DeviceResumeConfirmedSchema>
