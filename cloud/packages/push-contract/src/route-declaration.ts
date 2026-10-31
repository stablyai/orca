import { z } from 'zod'
import { PushDeviceRegistrationRequestSchema } from './device-registration-messages.js'
import { PUSH_LIMITS } from './push-limits.js'
export { pushRouteDeclarationContent } from './route-declaration-content.js'

const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const fingerprint = z.string().regex(/^[A-Za-z0-9_-]{16}$/)
const identity = {
  v: z.literal(1),
  platform: z.enum(['ios', 'android']),
  apnsEnvironment: z.enum(['sandbox', 'production']).optional(),
  token: z.string().min(1).max(4096),
  routeKey: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
}
function routeSchema(bounded: boolean) {
  return z
    .discriminatedUnion('action', [
      z.object({ action: z.literal('read'), ...identity }).strict(),
      z
        .object({
          action: z.literal('replace'),
          ...identity,
          version,
          expectedVersion: version.nullable(),
          hosts: bounded
            ? z.array(fingerprint).max(PUSH_LIMITS.maxRouteHosts)
            : z.array(fingerprint)
        })
        .strict()
    ])
    .refine(
      (value) =>
        PushDeviceRegistrationRequestSchema.safeParse({
          v: 1,
          deviceId: 'route',
          platform: value.platform,
          token: value.token,
          ...(value.apnsEnvironment ? { apnsEnvironment: value.apnsEnvironment } : {})
        }).success
    )
}
// The unbounded-count parser distinguishes a well-shaped over-count request from malformed input.
export const PushRouteDeclarationInputSchema = routeSchema(false)
export const PushRouteDeclarationSchema = routeSchema(true)
const hosts = z
  .array(fingerprint)
  .max(PUSH_LIMITS.maxRouteHosts)
  .refine((values) =>
    values.every((value, index) => index === 0 || value > (values[index - 1] ?? value))
  )
export const PushRouteCurrentSchema = z
  .object({
    status: z.literal('current'),
    version: version.nullable(),
    hosts
  })
  .strict()
  .refine((value) => value.version !== null || value.hosts.length === 0)
export const PushRouteAcceptedSchema = z.object({ status: z.literal('accepted'), version }).strict()
export type PushRouteDeclaration = z.infer<typeof PushRouteDeclarationSchema>
export type PushRouteCurrent = z.infer<typeof PushRouteCurrentSchema>
