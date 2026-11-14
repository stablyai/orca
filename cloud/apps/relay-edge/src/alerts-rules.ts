// Edge alert rules over per-window counts (alerts.ts reads them). Every message carries counts and
// shares only: never a user, host, device or connection id.

export type AlertsEnv = {
  ACCOUNT_ID: string
  DATASET: string
  ENVIRONMENT: string
  AE_READ_TOKEN: string
  ALERT_WEBHOOK_URL: string
  // Below this many hellos (phone_open + control_active) per window, ratio rules stay quiet.
  // Default 200; scale it with the cohort on the edge.
  MIN_VOLUME?: string
  // The edge's public origin; each run probes it (alerts-probe.ts). Absent: no probe.
  EDGE_PROBE_URL?: string
  // reconnect-surge fires at max(3x the previous window, this) control hellos. Default 50.
  RECONNECT_SURGE_MIN?: string
  // cloudflare-errors (alerts-cloudflare.ts): skipped while CF_GRAPHQL_TOKEN (secret, Account
  // Analytics: Read) is unset. Script defaults to 'orca-relay-edge'; CF_DO_NAMESPACE_IDS
  // (comma-separated) adds the edge's Durable Object namespaces. Fires above CF_ERRORS_MIN (20)
  // errors and CF_ERRORS_PCT (1) percent of invocations per window.
  CF_GRAPHQL_TOKEN?: string
  // '1': use AE_READ_TOKEN for the GraphQL query when CF_GRAPHQL_TOKEN is unset.
  CF_GRAPHQL_USE_AE_TOKEN?: string
  CF_SCRIPT_NAME?: string
  CF_DO_NAMESPACE_IDS?: string
  CF_ERRORS_MIN?: string
  CF_ERRORS_PCT?: string
}

export type Thresholds = { minVolume: number; surgeMin: number; cfErrorsMin: number; cfErrorsPct: number }

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function thresholds(env: AlertsEnv): Thresholds {
  return {
    minVolume: positive(env.MIN_VOLUME, 200),
    surgeMin: positive(env.RECONNECT_SURGE_MIN, 50),
    cfErrorsMin: positive(env.CF_ERRORS_MIN, 20),
    cfErrorsPct: positive(env.CF_ERRORS_PCT, 1)
  }
}

export const WINDOW_MIN = 15
// Per window, whatever the volume.
const ADMIN_FAILURES_MIN = 3
const LOW_VOLUME_4401_MIN = 5
// Admin labels that are an answer the director expects ('<op>:<outcome>'); anything else (a status
// such as assign:401, or stale / conflict / error) is a failure.
export const ADMIN_SUCCESS_LABELS = [
  'assign:applied',
  'assign:unchanged',
  'export:exported',
  'export:busy',
  'erase:erased',
  'erase:busy',
  'erase:mismatch',
  'drain:drained',
  'drain:idle'
]

export type Counts = Record<string, number>
// `prior` is the previous window; rules that compare against it never count as breaching "before".
export type Rule = { id: string; describe: (now: Counts) => string; breach: (c: Counts, t: Thresholds, prior?: Counts) => boolean }

// Counts per window, weighted by Analytics Engine sampling.
export const SQL = (dataset: string, fromMin: number, toMin: number) => `
SELECT
  sumIf(_sample_interval, blob1 = 'phone_open') AS phone_open,
  sumIf(_sample_interval, blob1 = 'control_active') AS control_active,
  sumIf(_sample_interval, blob1 = 'control_active' AND blob2 IN ('new', 'rebind')) AS reconnects,
  sumIf(_sample_interval, blob1 = 'refuse' AND endsWith(blob2, ':4401')) AS refuse_4401,
  sumIf(_sample_interval, blob1 = 'refuse' AND (endsWith(blob2, ':4429') OR endsWith(blob2, ':4503'))) AS refuse_busy,
  sumIf(_sample_interval, blob1 = 'control_close') AS control_close,
  sumIf(_sample_interval, blob1 = 'db_op') AS db_ops,
  sumIf(_sample_interval, blob1 = 'db_op' AND blob2 != 'ok') AS db_failures,
  sumIf(_sample_interval, blob1 = 'admin' AND blob2 NOT IN (${ADMIN_SUCCESS_LABELS.map((l) => `'${l}'`).join(', ')})) AS admin_failures,
  sum(_sample_interval) AS events
FROM ${dataset}
WHERE timestamp > NOW() - INTERVAL '${fromMin}' MINUTE AND timestamp <= NOW() - INTERVAL '${toMin}' MINUTE
FORMAT JSON`

// Analytics Engine has no conditional quantile, so database latency is its own query.
export const DB_P95_SQL = (dataset: string, fromMin: number, toMin: number) => `
SELECT quantileExactWeighted(0.95)(double1, _sample_interval) AS db_p95_ms
FROM ${dataset}
WHERE blob1 = 'db_op' AND timestamp > NOW() - INTERVAL '${fromMin}' MINUTE AND timestamp <= NOW() - INTERVAL '${toMin}' MINUTE
FORMAT JSON`

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0)
const hellos = (c: Counts) => c.phone_open + c.control_active

export const RULES: Rule[] = [
  {
    // 4401 disables phone credentials; a spike means the edge is wrongly refusing good clients.
    id: 'auth-refusals',
    breach: (c, t) => hellos(c) >= t.minVolume && pct(c.refuse_4401, hellos(c)) > 0.5,
    describe: (c) => `4401 refusals ${c.refuse_4401} = ${pct(c.refuse_4401, hellos(c)).toFixed(2)}% of hellos`
  },
  {
    id: 'busy-refusals',
    breach: (c, t) => hellos(c) >= t.minVolume && pct(c.refuse_busy, hellos(c)) > 5,
    describe: (c) => `4429/4503 refusals ${c.refuse_busy} = ${pct(c.refuse_busy, hellos(c)).toFixed(1)}% of hellos`
  },
  {
    id: 'database',
    breach: (c) => c.db_ops >= 20 && (pct(c.db_failures, c.db_ops) > 1 || c.db_p95_ms > 300),
    describe: (c) => `database failures ${pct(c.db_failures, c.db_ops).toFixed(1)}% of ${c.db_ops} ops, p95 ${Math.round(c.db_p95_ms)} ms`
  },
  {
    // Mass drop: control closes jump to 3x the previous window.
    id: 'mass-drop',
    breach: (c, t, prior) => prior !== undefined && c.control_close >= t.minVolume && c.control_close > 3 * Math.max(1, prior.control_close),
    describe: (c) => `control closes ${c.control_close} in ${WINDOW_MIN} min, over 3x the previous window`
  },
  {
    // Mass drop with no close events (object reset or eviction drops sockets silently): the
    // desktops come back, so control hellos jump. Floor keeps a small cohort's noise quiet.
    id: 'reconnect-surge',
    breach: (c, t, prior) => prior !== undefined && (c.reconnects ?? 0) >= Math.max(3 * (prior.reconnects ?? 0), t.surgeMin),
    describe: (c) => `control hellos ${c.reconnects ?? 0} in ${WINDOW_MIN} min, at least 3x the previous window`
  },
  {
    // The director's calls failing (bad signature, stale or conflicting pushes, errors).
    id: 'admin-failures',
    breach: (c) => c.admin_failures >= ADMIN_FAILURES_MIN,
    describe: (c) => `${c.admin_failures} failed admin calls in ${WINDOW_MIN} min`
  },
  {
    // Below the share rules' volume a handful of 4401s is still worth a look.
    id: 'auth-refusals-low-volume',
    breach: (c, t) => hellos(c) < t.minVolume && c.refuse_4401 >= LOW_VOLUME_4401_MIN,
    describe: (c) => `4401 refusals ${c.refuse_4401} in ${WINDOW_MIN} min at low volume (${hellos(c)} hellos)`
  },
  {
    // Dead man: traffic stopped (the edge or its metrics went silent) after a window that had some.
    id: 'silent',
    breach: (c, t, prior) => prior !== undefined && prior.events >= t.minVolume && c.events === 0,
    describe: () => `no edge events in ${WINDOW_MIN} min`
  },
  {
    // Worker / Durable Object invocations that ended in an error (Cloudflare GraphQL; absent when
    // CF_GRAPHQL_TOKEN is unset, and then never breaching).
    id: 'cloudflare-errors',
    breach: (c, t) => (c.cf_errors ?? 0) > t.cfErrorsMin && pct(c.cf_errors ?? 0, c.cf_invocations ?? 0) > t.cfErrorsPct,
    describe: (c) => `Worker/Durable Object errors ${c.cf_errors} = ${pct(c.cf_errors ?? 0, c.cf_invocations ?? 0).toFixed(1)}% of ${c.cf_invocations} invocations in ${WINDOW_MIN} min`
  }
]
