import type { ConnectorHost } from './connector-host'

export type Env = {
  CONNECTOR_HOST: DurableObjectNamespace<ConnectorHost>
  // Wake tokens: verified against the auth service's JWKS (stale-if-error per isolate, then the
  // colo's last good set in the Cache API, jwks-persist.ts). WAKE_JWKS (inline set) is for local
  // tests and the spike only.
  WAKE_JWKS_URL?: string
  WAKE_JWKS?: string
  WAKE_AUTH_ISSUER?: string
  // Comma-separated ISO countries whose upgrades are closed 4403 (default CN).
  WAKE_REFUSE_COUNTRIES?: string
  // The connector's publisher key (HS256, >= 32 chars) and its issuer; _NEXT while rotating (admin.ts).
  WAKE_ADMIN_KEY?: string
  WAKE_ADMIN_KEY_NEXT?: string
  WAKE_ADMIN_ISSUER?: string
  // Spike only: '1' answers GET /__spike/object/<hostId> (object colo, design W7). Never deployed.
  SPIKE_DEBUG?: string
  // Version label baked in per deploy (--var EDGE_VERSION:<tag>), reported by metrics.
  EDGE_VERSION?: string
  METRICS?: AnalyticsEngineDataset
  // Per-source limit on the upgrade and the object health probe, before auth (Rate Limiting binding).
  PREAUTH_LIMITER?: RateLimit
}

export type WakeConfig = {
  refuseCountries: Set<string>
}

const configs = new WeakMap<object, WakeConfig>()
const DEFAULT_REFUSE_COUNTRIES = 'CN'

// Validated once per isolate. A misconfigured deploy fails every request loudly (500).
export function wakeConfig(env: Env): WakeConfig {
  const cached = configs.get(env)
  if (cached) { return cached }
  if (!env.WAKE_JWKS_URL && !env.WAKE_JWKS) { throw new Error('connector_wake_config_jwks') }
  if (env.WAKE_JWKS_URL && !env.WAKE_AUTH_ISSUER) { throw new Error('connector_wake_config_issuer') }
  if (!env.WAKE_ADMIN_KEY || env.WAKE_ADMIN_KEY.length < 32 || !env.WAKE_ADMIN_ISSUER) { throw new Error('connector_wake_config_admin') }
  // A rotation key, once set, must be as strong as the primary ('' counts as cleared).
  if (env.WAKE_ADMIN_KEY_NEXT && env.WAKE_ADMIN_KEY_NEXT.length < 32) { throw new Error('connector_wake_config_admin_next') }
  const countries = (env.WAKE_REFUSE_COUNTRIES ?? DEFAULT_REFUSE_COUNTRIES).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) { throw new Error('connector_wake_config_refuse_countries') }
  const config: WakeConfig = { refuseCountries: new Set(countries) }
  configs.set(env, config)
  return config
}
