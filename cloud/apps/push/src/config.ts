import { PUSH_DEFAULTS, PUSH_LIMITS } from '@orca-cloud/push-contract'
import { z } from 'zod'

export const PUSH_DATABASE_POOL_MAX = 10

const OptionalTextSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional()
)

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  ORCA_PUSH_PUBLIC_URL: z.string().url(),
  ORCA_PUSH_DATABASE_URL: OptionalTextSchema,
  ORCA_PUSH_DATA_DIR: z.string().min(1).default('./data/push'),
  ORCA_PUSH_DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).optional(),
  ORCA_PUSH_APNS_KEY: OptionalTextSchema,
  ORCA_PUSH_APNS_KEY_ID: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^[A-Z0-9]{10}$/).optional()
  ),
  ORCA_PUSH_APPLE_TEAM_ID: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^[A-Z0-9]{10}$/).optional()
  ),
  ORCA_PUSH_APNS_TOPIC: z.string().min(1).max(255).default(PUSH_DEFAULTS.apnsTopic),
  ORCA_PUSH_FCM_PROJECT_ID: z
    .string()
    .regex(/^[a-z0-9-]{4,64}$/)
    .default(PUSH_DEFAULTS.fcmProjectId),
  ORCA_PUSH_COALESCE_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(60_000)
    .default(PUSH_LIMITS.coalesceWindowMs),
  // How many proxies append to x-forwarded-for after the client. 0 is Cloud Run
  // alone; raise it to 1 when a load balancer fronts the service.
  ORCA_PUSH_TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().max(8).default(0)
})

export type ApnsCredentials = { keyPem: string; keyId: string; teamId: string }

export type PushConfig = {
  port: number
  publicUrl: string
  databaseUrl?: string
  dataDir: string
  databasePoolMax: number
  apns?: ApnsCredentials
  apnsTopic: string
  fcmProjectId: string
  coalesceMs: number
  trustedProxyHops: number
}

function canonicalOrigin(value: string, name: string): string {
  const url = new URL(value)
  if (url.origin !== value || url.pathname !== '/') throw new Error(`${name} must be an origin`)
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS outside loopback development`)
  }
  return value
}

// The APNs key, key id, and team id are one credential; a partial set would
// pass startup and then fail every iOS send at runtime.
function readApnsCredentials(
  parsed: z.infer<typeof EnvSchema>
): ApnsCredentials | undefined {
  const parts = [
    parsed.ORCA_PUSH_APNS_KEY,
    parsed.ORCA_PUSH_APNS_KEY_ID,
    parsed.ORCA_PUSH_APPLE_TEAM_ID
  ]
  const present = parts.filter((value) => value !== undefined).length
  if (present === 0) return undefined
  if (present !== parts.length) {
    throw new Error('APNs key, key id, and team id must be configured together')
  }
  const keyPem = parsed.ORCA_PUSH_APNS_KEY!
  if (!keyPem.includes('-----BEGIN')) throw new Error('ORCA_PUSH_APNS_KEY must be PEM text')
  return {
    keyPem,
    keyId: parsed.ORCA_PUSH_APNS_KEY_ID!,
    teamId: parsed.ORCA_PUSH_APPLE_TEAM_ID!
  }
}

export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  const parsed = EnvSchema.parse(env)
  return {
    port: parsed.PORT,
    publicUrl: canonicalOrigin(parsed.ORCA_PUSH_PUBLIC_URL, 'ORCA_PUSH_PUBLIC_URL'),
    databaseUrl: parsed.ORCA_PUSH_DATABASE_URL,
    dataDir: parsed.ORCA_PUSH_DATA_DIR,
    databasePoolMax: parsed.ORCA_PUSH_DATABASE_POOL_MAX ?? PUSH_DATABASE_POOL_MAX,
    apns: readApnsCredentials(parsed),
    apnsTopic: parsed.ORCA_PUSH_APNS_TOPIC,
    fcmProjectId: parsed.ORCA_PUSH_FCM_PROJECT_ID,
    coalesceMs: parsed.ORCA_PUSH_COALESCE_MS,
    trustedProxyHops: parsed.ORCA_PUSH_TRUSTED_PROXY_HOPS
  }
}
