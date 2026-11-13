import type { HostRelay } from './host-relay'
import type { SpliceRelay } from './splice-relay'
import { INGRESS_SECRET_MIN_LENGTH } from '../../../packages/relay-contract/src/ingress-header'
import { parseCidr, type Cidr } from './ingress'

export interface Env {
  HOST_RELAY: DurableObjectNamespace<HostRelay>
  SPLICE_RELAY: DurableObjectNamespace<SpliceRelay>
  // Pooled connection to the relay's Postgres (credentials, invites, devices, assignments).
  HYPERDRIVE?: Hyperdrive
  // 'postgres' (MVP and production) or 'spike' (no database: stub credentials, no epoch check).
  EDGE_BACKEND?: string
  // The cell id directors write into relay_assignments for hosts placed on the edge.
  EDGE_CELL_ID?: string
  // Relay JWTs: verified against the auth service's JWKS (fetched, cached per isolate, served
  // stale for up to 30 min if auth is unreachable). RELAY_JWKS (inline set) is for local tests and
  // the spike only.
  RELAY_JWKS_URL?: string
  RELAY_JWKS?: string
  RELAY_AUTH_ISSUER?: string
  RELAY_JWT_AUDIENCE: string
  PING_INTERVAL_MS: string
  SILENCE_TIMEOUT_MS: string
  ORPHAN_GRACE_MS: string
  // Object backend: store cleanup cadence (default 24 h) and how long an object keeps the data of
  // a host that moved away before wiping it (default 30 days). Tests shorten both.
  SWEEP_INTERVAL_MS?: string
  LEFT_RETENTION_MS?: string
  // Flood guard per splice direction: close 4429 if more than this many bytes reach a peer that
  // has sent nothing within the window. 0 disables (default; it cut healthy readers in the spike).
  SPLICE_SILENT_BYTES_MAX?: string
  SPLICE_SILENT_WINDOW_MS?: string
  // Spike backend only: comma-separated `<kind>:<relayDeviceId>:<sha256 b64url>` accepted tokens.
  SPIKE_RESUME_TOKEN_HASHES?: string
  // Spike/test only: /__spike/abort* reset routes.
  SPIKE_ADMIN?: string
  // Spike/test only: /__spike/info and /__spike/host/<id> debug endpoints (colo, version).
  SPIKE_DEBUG?: string
  // Version label baked in per deploy (--var EDGE_VERSION:<tag>), reported by metrics and debug.
  EDGE_VERSION?: string
  METRICS?: AnalyticsEngineDataset
  // Per-source limit on unauthenticated phone and host data upgrades (Rate Limiting binding).
  PREAUTH_LIMITER?: RateLimit
  // Phase 2 admin calls: the director's edge admin key (secret, not its lease key) and its public URL (iss).
  ADMIN_SIGNING_KEY?: string
  ADMIN_ISSUER?: string
  // Optional second signer for `erase` only (the account erasure job): it can never push.
  ERASE_SIGNING_KEY?: string
  ERASE_ISSUER?: string
  // Secret(s) shared with the ingress proxies (secret binding; comma-separated while rotating,
  // current first). Unset: ingress headers are ignored and every request is treated as direct.
  INGRESS_SECRETS?: string
  // Token-mode ingress (a cloud load balancer; see ingress.ts). All three or none. INGRESS_TOKENS is
  // a secret (comma-separated while rotating); the origins (comma-separated, exact https origins)
  // and the load balancer's egress CIDRs (comma-separated, from scripts/ingress-source-cidrs.ts)
  // are plain vars. Unset: `v1s` headers are ignored.
  INGRESS_TOKENS?: string
  INGRESS_ORIGINS?: string
  INGRESS_SOURCE_CIDRS?: string
}

export type EdgeClaims = {
  userId: string
  profileId: string
  organizationId: string
  relayHostId: string
  exp: number
}

export type EdgeConfig = {
  backend: 'object' | 'postgres' | 'spike'
  cellId: string
  pingIntervalMs: number
  silenceTimeoutMs: number
  orphanGraceMs: number
  sweepIntervalMs: number
  leftRetentionMs: number
  ingressSecrets: string[]
  ingressToken: { tokens: string[]; origins: string[]; sourceCidrs: Cidr[] }
}

const configs = new WeakMap<object, EdgeConfig>()

function positiveInt(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`relay_edge_config_${name}`)
  return parsed
}

// Validated once per isolate. A misconfigured deploy fails every request loudly (500) rather than
// running with a silently wrong backend: the spike backend skips credential and epoch checks.
export function edgeConfig(env: Env): EdgeConfig {
  const cached = configs.get(env)
  if (cached) return cached
  const backend = env.EDGE_BACKEND ?? 'postgres'
  if (backend !== 'object' && backend !== 'postgres' && backend !== 'spike') throw new Error('relay_edge_config_backend')
  // Phase 2: assignments arrive only through signed director pushes.
  if (backend === 'object' && (!env.ADMIN_SIGNING_KEY || env.ADMIN_SIGNING_KEY.length < 32 || !env.ADMIN_ISSUER)) {
    throw new Error('relay_edge_config_admin')
  }
  if (backend === 'postgres' && !env.HYPERDRIVE) throw new Error('relay_edge_config_hyperdrive')
  if (backend === 'spike' && env.SPIKE_DEBUG !== '1' && env.SPIKE_ADMIN !== '1') {
    throw new Error('relay_edge_config_spike_backend_outside_spike')
  }
  if (!env.RELAY_JWKS_URL && !env.RELAY_JWKS) throw new Error('relay_edge_config_jwks')
  if (env.RELAY_JWKS_URL && !env.RELAY_AUTH_ISSUER) throw new Error('relay_edge_config_issuer')
  if (!env.RELAY_JWT_AUDIENCE) throw new Error('relay_edge_config_audience')
  const ingressSecrets = env.INGRESS_SECRETS ? env.INGRESS_SECRETS.split(',').map((s) => s.trim()) : []
  if (ingressSecrets.some((s) => s.length < INGRESS_SECRET_MIN_LENGTH)) throw new Error('relay_edge_config_ingress')
  const ingressToken = ingressTokenConfig(env)
  const config: EdgeConfig = {
    backend,
    cellId: env.EDGE_CELL_ID || 'edge',
    pingIntervalMs: positiveInt('ping_interval', env.PING_INTERVAL_MS),
    silenceTimeoutMs: positiveInt('silence_timeout', env.SILENCE_TIMEOUT_MS),
    orphanGraceMs: positiveInt('orphan_grace', env.ORPHAN_GRACE_MS),
    sweepIntervalMs: positiveInt('sweep_interval', env.SWEEP_INTERVAL_MS ?? String(24 * 60 * 60 * 1000)),
    leftRetentionMs: positiveInt('left_retention', env.LEFT_RETENTION_MS ?? String(30 * 24 * 60 * 60 * 1000)),
    ingressSecrets,
    ingressToken
  }
  // Shipped desktops close a control that is silent for 75 s; a ping must arrive well inside it.
  if (config.pingIntervalMs >= config.silenceTimeoutMs) throw new Error('relay_edge_config_ping_interval')
  configs.set(env, config)
  return config
}

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// Token mode is all or nothing: a partial setup fails every request rather than trusting less.
function ingressTokenConfig(env: Env): EdgeConfig['ingressToken'] {
  const tokens = list(env.INGRESS_TOKENS)
  const origins = list(env.INGRESS_ORIGINS)
  const cidrs = list(env.INGRESS_SOURCE_CIDRS)
  if (tokens.length + origins.length + cidrs.length === 0) return { tokens: [], origins: [], sourceCidrs: [] }
  const sourceCidrs = cidrs.map(parseCidr)
  const originOk = (o: string) => URL.canParse(o) && new URL(o).protocol === 'https:' && new URL(o).origin === o
  if (
    tokens.length === 0 || origins.length === 0 || cidrs.length === 0 ||
    tokens.some((t) => t.length < INGRESS_SECRET_MIN_LENGTH || /\s/.test(t)) ||
    !origins.every(originOk) || sourceCidrs.some((c) => c === null)
  ) {
    throw new Error('relay_edge_config_ingress_token')
  }
  return { tokens, origins, sourceCidrs: sourceCidrs as Cidr[] }
}
