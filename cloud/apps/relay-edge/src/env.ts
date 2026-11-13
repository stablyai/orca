import type { HostRelay } from './host-relay'
import type { SpliceRelay } from './splice-relay'
import { INGRESS_SECRET_MIN_LENGTH } from '../../../packages/relay-contract/src/ingress-header'
import { parseCidr, type Cidr } from './ingress'
import { metric } from './metrics'

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
  // current first). Unset or malformed (see ingressConfig): ingress headers are ignored and every
  // request is treated as direct.
  INGRESS_SECRETS?: string
  // Token-mode ingress (a cloud load balancer; see ingress.ts). All three or none; a partial or
  // malformed setup switches token mode off and reports why, it never fails requests. INGRESS_TOKENS is
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
  // Empty when that mode is off (unset, or switched off by a problem below).
  ingressSecrets: string[]
  ingressToken: { tokens: string[]; origins: string[]; sourceCidrs: Cidr[] }
  // Why an ingress mode is off despite being configured (labels only, never values).
  ingressProblems: string[]
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
  const ingress = ingressConfig(env)
  const config: EdgeConfig = {
    backend,
    cellId: env.EDGE_CELL_ID || 'edge',
    pingIntervalMs: positiveInt('ping_interval', env.PING_INTERVAL_MS),
    silenceTimeoutMs: positiveInt('silence_timeout', env.SILENCE_TIMEOUT_MS),
    orphanGraceMs: positiveInt('orphan_grace', env.ORPHAN_GRACE_MS),
    sweepIntervalMs: positiveInt('sweep_interval', env.SWEEP_INTERVAL_MS ?? String(24 * 60 * 60 * 1000)),
    leftRetentionMs: positiveInt('left_retention', env.LEFT_RETENTION_MS ?? String(30 * 24 * 60 * 60 * 1000)),
    ...ingress
  }
  // Shipped desktops close a control that is silent for 75 s; a ping must arrive well inside it.
  if (config.pingIntervalMs >= config.silenceTimeoutMs) throw new Error('relay_edge_config_ping_interval')
  configs.set(env, config)
  if (config.ingressProblems.length > 0) {
    // Never thrown: this runs on every request and in every object's alarms. A secret landing
    // before its vars (or one bad range) switches that ingress mode off, loudly, and nothing else.
    console.error(JSON.stringify({ event: 'relay_edge_ingress_config_invalid', problems: config.ingressProblems }))
    for (const problem of config.ingressProblems) metric(env, 'ingress_config_invalid', 1, problem)
  }
  return config
}

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
// Narrower than this is a typo, not a load balancer's egress set.
const MIN_PREFIX = { v4: 8, v6: 16 }
const TOKEN_OFF: EdgeConfig['ingressToken'] = { tokens: [], origins: [], sourceCidrs: [] }

// Each mode is all or nothing: a partial or malformed setup turns that mode off (requests are then
// treated as direct) and reports why; it never throws.
function ingressConfig(env: Env): Pick<EdgeConfig, 'ingressSecrets' | 'ingressToken' | 'ingressProblems'> {
  const problems: string[] = []
  let ingressSecrets = list(env.INGRESS_SECRETS)
  if (ingressSecrets.some((s) => s.length < INGRESS_SECRET_MIN_LENGTH)) {
    problems.push('secret_too_short')
    ingressSecrets = []
  }
  const tokens = list(env.INGRESS_TOKENS)
  const origins = list(env.INGRESS_ORIGINS)
  const cidrs = list(env.INGRESS_SOURCE_CIDRS)
  if (tokens.length + origins.length + cidrs.length === 0) return { ingressSecrets, ingressToken: TOKEN_OFF, ingressProblems: problems }
  const sourceCidrs = cidrs.map(parseCidr)
  const originOk = (o: string) => URL.canParse(o) && new URL(o).protocol === 'https:' && new URL(o).origin === o
  const tokenProblems = [
    tokens.length === 0 || origins.length === 0 || cidrs.length === 0 ? 'token_mode_partial' : '',
    tokens.some((t) => t.length < INGRESS_SECRET_MIN_LENGTH || /\s/.test(t)) ? 'token_too_short' : '',
    origins.every(originOk) ? '' : 'origin_invalid',
    sourceCidrs.some((c) => c === null) ? 'cidr_invalid' : '',
    sourceCidrs.some((c) => c !== null && c.bits < (c.v6 ? MIN_PREFIX.v6 : MIN_PREFIX.v4)) ? 'cidr_too_broad' : ''
  ].filter(Boolean)
  if (tokenProblems.length > 0) return { ingressSecrets, ingressToken: TOKEN_OFF, ingressProblems: problems.concat(tokenProblems) }
  return { ingressSecrets, ingressToken: { tokens, origins, sourceCidrs: sourceCidrs as Cidr[] }, ingressProblems: problems }
}
