import type { HostRelay } from './host-relay'
import type { SpliceRelay } from './splice-relay'

export type Env = {
  HOST_RELAY: DurableObjectNamespace<HostRelay>
  SPLICE_RELAY: DurableObjectNamespace<SpliceRelay>
  // Pooled connection to the relay's Postgres (credentials, invites, devices, assignments).
  HYPERDRIVE?: Hyperdrive
  // 'postgres' (MVP and production) or 'spike' (no database: stub credentials, no epoch check).
  EDGE_BACKEND?: string
  // The cell id directors write into relay_assignments for hosts placed on the edge.
  EDGE_CELL_ID?: string
  // Relay JWTs: verified against the auth service's JWKS (fetched, cached per isolate, served
  // stale for up to 30 min if auth is unreachable; a cold isolate falls back to the colo's last
  // good set in the Cache API for up to 24 h, jwks-persist.ts). RELAY_JWKS (inline set) is for local tests and
  // the spike only.
  RELAY_JWKS_URL?: string
  RELAY_JWKS?: string
  RELAY_AUTH_ISSUER?: string
  RELAY_JWT_AUDIENCE: string
  PING_INTERVAL_MS: string
  SILENCE_TIMEOUT_MS: string
  ORPHAN_GRACE_MS: string
  // '0' stops offering the host-sent keepalive (host-relay-control.ts) and pings every control from
  // the alarm again, including controls that took the offer earlier. Default: offered.
  CLIENT_KEEPALIVE?: string
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
  // Key rotation (admin.ts): a second accepted key while the director moves to it. >= 32 chars.
  ADMIN_SIGNING_KEY_NEXT?: string
  // '1': admin tokens without a `jti` are refused (401). Default off while the director adopts jti.
  ADMIN_REQUIRE_JTI?: string
  // Optional second signer for `erase` only (the account erasure job): it can never push.
  ERASE_SIGNING_KEY?: string
  ERASE_SIGNING_KEY_NEXT?: string
  ERASE_ISSUER?: string
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
  clientKeepalive: boolean
}

const configs = new WeakMap<object, EdgeConfig>()

function positiveInt(name: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) { throw new Error(`relay_edge_config_${name}`) }
  return parsed
}

// Validated once per isolate. A misconfigured deploy fails every request loudly (500) rather than
// running with a silently wrong backend: the spike backend skips credential and epoch checks.
export function edgeConfig(env: Env): EdgeConfig {
  const cached = configs.get(env)
  if (cached) { return cached }
  const backend = env.EDGE_BACKEND ?? 'postgres'
  if (backend !== 'object' && backend !== 'postgres' && backend !== 'spike') { throw new Error('relay_edge_config_backend') }
  // Phase 2: assignments arrive only through signed director pushes.
  if (backend === 'object' && (!env.ADMIN_SIGNING_KEY || env.ADMIN_SIGNING_KEY.length < 32 || !env.ADMIN_ISSUER)) {
    throw new Error('relay_edge_config_admin')
  }
  // A rotation key, once set, must be as strong as the primary ('' counts as cleared).
  if (env.ADMIN_SIGNING_KEY_NEXT && env.ADMIN_SIGNING_KEY_NEXT.length < 32) { throw new Error('relay_edge_config_admin_next') }
  if (env.ERASE_SIGNING_KEY_NEXT && env.ERASE_SIGNING_KEY_NEXT.length < 32) { throw new Error('relay_edge_config_erase_next') }
  if (backend === 'postgres' && !env.HYPERDRIVE) { throw new Error('relay_edge_config_hyperdrive') }
  if (backend === 'spike' && env.SPIKE_DEBUG !== '1' && env.SPIKE_ADMIN !== '1') {
    throw new Error('relay_edge_config_spike_backend_outside_spike')
  }
  // The abort routes reset objects (drop every socket); only the spike backend may turn them on.
  if (env.SPIKE_ADMIN === '1' && backend !== 'spike') { throw new Error('relay_edge_config_spike_admin_outside_spike') }
  if (!env.RELAY_JWKS_URL && !env.RELAY_JWKS) { throw new Error('relay_edge_config_jwks') }
  if (env.RELAY_JWKS_URL && !env.RELAY_AUTH_ISSUER) { throw new Error('relay_edge_config_issuer') }
  if (!env.RELAY_JWT_AUDIENCE) { throw new Error('relay_edge_config_audience') }
  const config: EdgeConfig = {
    backend,
    cellId: env.EDGE_CELL_ID || 'edge',
    pingIntervalMs: positiveInt('ping_interval', env.PING_INTERVAL_MS),
    silenceTimeoutMs: positiveInt('silence_timeout', env.SILENCE_TIMEOUT_MS),
    orphanGraceMs: positiveInt('orphan_grace', env.ORPHAN_GRACE_MS),
    sweepIntervalMs: positiveInt('sweep_interval', env.SWEEP_INTERVAL_MS ?? String(24 * 60 * 60 * 1000)),
    leftRetentionMs: positiveInt('left_retention', env.LEFT_RETENTION_MS ?? String(30 * 24 * 60 * 60 * 1000)),
    clientKeepalive: env.CLIENT_KEEPALIVE !== '0'
  }
  // The offer carries the ping interval, which the contract bounds to 1..60 s.
  config.clientKeepalive &&= config.pingIntervalMs >= 1_000 && config.pingIntervalMs <= 60_000
  // Shipped desktops close a control that is silent for 75 s; a ping must arrive well inside it.
  if (config.pingIntervalMs >= config.silenceTimeoutMs) { throw new Error('relay_edge_config_ping_interval') }
  configs.set(env, config)
  return config
}
