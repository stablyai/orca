import { z } from 'zod'

const OptionalTextSchema = z.string().min(1).optional()

const EnvSchema = z.object({
  ORCA_CONNECTOR_MODE: z.enum(['active', 'validation']).default('active'),
  PORT: z.coerce.number().int().positive().default(8080),
  ORCA_CONNECTOR_PUBLIC_URL: z.string().url(),
  ORCA_CONNECTOR_DATABASE_URL: OptionalTextSchema,
  ORCA_CONNECTOR_DATA_DIR: z.string().min(1).default('./data/connector'),
  ORCA_CONNECTOR_DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  ORCA_CONNECTOR_AUTH_ISSUER: z.string().url(),
  ORCA_CONNECTOR_JWKS_URL: z.string().url(),
  // As push: proxies appending to x-forwarded-for after the client (0 is Cloud Run alone).
  ORCA_CONNECTOR_TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().max(8).default(0)
})

export type ConnectorConfig = {
  mode: 'active' | 'validation'
  port: number
  publicUrl: string
  databaseUrl?: string
  dataDir: string
  databasePoolMax: number
  authIssuer: string
  jwksUrl: string
  trustedProxyHops: number
}

function secureUrl(value: string, name: string): URL {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS outside loopback development`)
  }
  return url
}

function canonicalOrigin(value: string, name: string): string {
  if (secureUrl(value, name).origin !== value) {
    throw new Error(`${name} must be an origin`)
  }
  return value
}

export function loadConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const parsed = EnvSchema.parse(
    Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, value?.trim() === '' ? undefined : value])
    )
  )
  return {
    mode: parsed.ORCA_CONNECTOR_MODE,
    port: parsed.PORT,
    publicUrl: canonicalOrigin(parsed.ORCA_CONNECTOR_PUBLIC_URL, 'ORCA_CONNECTOR_PUBLIC_URL'),
    ...(parsed.ORCA_CONNECTOR_DATABASE_URL === undefined
      ? {}
      : { databaseUrl: parsed.ORCA_CONNECTOR_DATABASE_URL }),
    dataDir: parsed.ORCA_CONNECTOR_DATA_DIR,
    databasePoolMax: parsed.ORCA_CONNECTOR_DATABASE_POOL_MAX,
    authIssuer: canonicalOrigin(parsed.ORCA_CONNECTOR_AUTH_ISSUER, 'ORCA_CONNECTOR_AUTH_ISSUER'),
    // The signing keys come from here, so plain HTTP would let anyone on the path mint tokens.
    jwksUrl: secureUrl(parsed.ORCA_CONNECTOR_JWKS_URL, 'ORCA_CONNECTOR_JWKS_URL').href,
    trustedProxyHops: parsed.ORCA_CONNECTOR_TRUSTED_PROXY_HOPS
  }
}
