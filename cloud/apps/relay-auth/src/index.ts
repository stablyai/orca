import { readFileSync, statSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { z } from 'zod'
import { createService } from './service.js'

process.umask(0o077)

const env = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  ORCA_AUTH_ISSUER: z.string().url(),
  ORCA_AUTH_CLIENT_ID: z.string().min(1).max(2048).default('orca-desktop'),
  ORCA_AUTH_ADMIN_SECRET: z.string().min(32).optional(),
  ORCA_AUTH_EMAIL: z.email().optional(),
  ORCA_AUTH_UPSTREAM_ISSUER: z.string().url().optional(),
  ORCA_AUTH_UPSTREAM_CLIENT_ID: z.string().min(1).optional(),
  ORCA_AUTH_UPSTREAM_TOKEN_ENDPOINT_AUTH_METHOD: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
  ORCA_AUTH_UPSTREAM_CLIENT_SECRET: z.string().min(1).optional(),
  ORCA_AUTH_UPSTREAM_ALLOWED_EMAILS: z.string().optional(),
  ORCA_AUTH_UPSTREAM_ALLOWED_DOMAINS: z.string().optional(),
  ORCA_AUTH_UPSTREAM_ALLOW_ANY: z.enum(['true', 'false']).default('false'),
  ORCA_AUTH_UPSTREAM_ALLOW_CROSS_ORIGIN: z.enum(['true', 'false']).default('false'),
  ORCA_AUTH_UPSTREAM_KEEP_SECRET_LOGIN: z.enum(['true', 'false']).default('false'),
  ORCA_AUTH_USER_ID: z.string().min(1).default('admin'),
  ORCA_AUTH_DATA_DIR: z.string().default('./data/relay-auth'),
  ORCA_AUTH_SIGNING_KEY_FILE: z.string().optional(),
  ORCA_AUTH_PREVIOUS_PUBLIC_KEY_FILE: z.string().optional(),
  ORCA_AUTH_TRUST_PROXY: z.enum(['true', 'false']).default('false')
}).parse(process.env)
const issuer = new URL(env.ORCA_AUTH_ISSUER)
if (issuer.origin !== env.ORCA_AUTH_ISSUER || (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)))) throw new Error('ORCA_AUTH_ISSUER must be an HTTPS origin or loopback HTTP origin')
if (env.ORCA_AUTH_UPSTREAM_ISSUER) {
  const upstream = new URL(env.ORCA_AUTH_UPSTREAM_ISSUER)
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || env.ORCA_AUTH_UPSTREAM_ISSUER.includes('?') || env.ORCA_AUTH_UPSTREAM_ISSUER.includes('#') || !env.ORCA_AUTH_UPSTREAM_CLIENT_ID) throw new Error('Upstream requires an HTTPS issuer without credentials, query or fragment and a client ID')
} else if (!env.ORCA_AUTH_ADMIN_SECRET || !env.ORCA_AUTH_EMAIL) throw new Error('Admin secret and email are required without upstream OIDC')
if (env.ORCA_AUTH_UPSTREAM_KEEP_SECRET_LOGIN === 'true' && (!env.ORCA_AUTH_ADMIN_SECRET || !env.ORCA_AUTH_EMAIL)) throw new Error('Secret login requires admin secret and email')
const list = (value?: string) => value?.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
if (env.ORCA_AUTH_SIGNING_KEY_FILE && process.platform !== 'win32' && (statSync(env.ORCA_AUTH_SIGNING_KEY_FILE).mode & 0o077) !== 0) throw new Error('ORCA_AUTH_SIGNING_KEY_FILE must not be group/world accessible')
const service = await createService({ issuer: env.ORCA_AUTH_ISSUER, clientId: env.ORCA_AUTH_CLIENT_ID, secret: env.ORCA_AUTH_ADMIN_SECRET ?? '', email: env.ORCA_AUTH_EMAIL ?? '', upstream: env.ORCA_AUTH_UPSTREAM_ISSUER && env.ORCA_AUTH_UPSTREAM_CLIENT_ID ? { issuer: env.ORCA_AUTH_UPSTREAM_ISSUER, clientId: env.ORCA_AUTH_UPSTREAM_CLIENT_ID, clientSecret: env.ORCA_AUTH_UPSTREAM_CLIENT_SECRET, tokenEndpointAuthMethod: env.ORCA_AUTH_UPSTREAM_TOKEN_ENDPOINT_AUTH_METHOD, allowedEmails: list(env.ORCA_AUTH_UPSTREAM_ALLOWED_EMAILS), allowedDomains: list(env.ORCA_AUTH_UPSTREAM_ALLOWED_DOMAINS), allowAny: env.ORCA_AUTH_UPSTREAM_ALLOW_ANY === 'true', allowCrossOrigin: env.ORCA_AUTH_UPSTREAM_ALLOW_CROSS_ORIGIN === 'true', keepSecretLogin: env.ORCA_AUTH_UPSTREAM_KEEP_SECRET_LOGIN === 'true' } : undefined, userId: env.ORCA_AUTH_USER_ID, dataDir: env.ORCA_AUTH_DATA_DIR, trustProxy: env.ORCA_AUTH_TRUST_PROXY === 'true', signingKey: env.ORCA_AUTH_SIGNING_KEY_FILE ? readFileSync(env.ORCA_AUTH_SIGNING_KEY_FILE, 'utf8') : undefined, previousPublicKey: env.ORCA_AUTH_PREVIOUS_PUBLIC_KEY_FILE ? readFileSync(env.ORCA_AUTH_PREVIOUS_PUBLIC_KEY_FILE, 'utf8') : undefined })
serve({ fetch: service.app.fetch, port: env.PORT })
