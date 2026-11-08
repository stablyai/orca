// Edge alerts: a separate cron Worker (wrangler.alerts.jsonc) so it keeps running when the edge
// itself is broken or mid-deploy. Every 5 min it reads the edge's Analytics Engine dataset over
// the SQL API and posts to a webhook when a rule starts breaching (and hourly while it persists).
// Stateless: "starts breaching" = breaching in the last window but not in the one before.
// Secrets (set from stdin, never in config or logs): AE_READ_TOKEN (Account Analytics: Read),
// ALERT_WEBHOOK_URL (Slack-compatible incoming webhook: POST {text}).
// Share rules need MIN_VOLUME hellos per window; the absolute-count rules (admin failures, 4401s
// below that volume) and the synthetic probe (EDGE_PROBE_URL, alerts-probe.ts) also cover a quiet edge.
import { probeEdge } from './alerts-probe'

export type AlertsEnv = {
  ACCOUNT_ID: string
  DATASET: string
  ENVIRONMENT: string
  AE_READ_TOKEN: string
  ALERT_WEBHOOK_URL: string
  // Below this many hellos (phone_open + control_active) per window, ratio rules stay quiet.
  MIN_VOLUME?: string
  // The edge's public origin; each run probes it (alerts-probe.ts). Absent: no probe.
  EDGE_PROBE_URL?: string
}

const WINDOW_MIN = 15
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

type Counts = Record<string, number>
// `prior` is the previous window; rules that compare against it never count as breaching "before".
type Rule = { id: string; describe: (now: Counts) => string; breach: (c: Counts, minVolume: number, prior?: Counts) => boolean }

// Counts per window, weighted by Analytics Engine sampling.
const SQL = (dataset: string, fromMin: number, toMin: number) => `
SELECT
  sumIf(_sample_interval, blob1 = 'phone_open') AS phone_open,
  sumIf(_sample_interval, blob1 = 'control_active') AS control_active,
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
const DB_P95_SQL = (dataset: string, fromMin: number, toMin: number) => `
SELECT quantileExactWeighted(0.95)(double1, _sample_interval) AS db_p95_ms
FROM ${dataset}
WHERE blob1 = 'db_op' AND timestamp > NOW() - INTERVAL '${fromMin}' MINUTE AND timestamp <= NOW() - INTERVAL '${toMin}' MINUTE
FORMAT JSON`

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0)

export const RULES: Rule[] = [
  {
    // 4401 disables phone credentials; a spike means the edge is wrongly refusing good clients.
    id: 'auth-refusals',
    breach: (c, min) => c.phone_open + c.control_active >= min && pct(c.refuse_4401, c.phone_open + c.control_active) > 0.5,
    describe: (c) => `4401 refusals ${c.refuse_4401} = ${pct(c.refuse_4401, c.phone_open + c.control_active).toFixed(2)}% of hellos`
  },
  {
    id: 'busy-refusals',
    breach: (c, min) => c.phone_open + c.control_active >= min && pct(c.refuse_busy, c.phone_open + c.control_active) > 5,
    describe: (c) => `4429/4503 refusals ${c.refuse_busy} = ${pct(c.refuse_busy, c.phone_open + c.control_active).toFixed(1)}% of hellos`
  },
  {
    id: 'database',
    breach: (c) => c.db_ops >= 20 && (pct(c.db_failures, c.db_ops) > 1 || c.db_p95_ms > 300),
    describe: (c) => `database failures ${pct(c.db_failures, c.db_ops).toFixed(1)}% of ${c.db_ops} ops, p95 ${Math.round(c.db_p95_ms)} ms`
  },
  {
    // Mass drop: control closes jump to 3x the previous window.
    id: 'mass-drop',
    breach: (c, min, prior) => prior !== undefined && c.control_close >= min && c.control_close > 3 * Math.max(1, prior.control_close),
    describe: (c) => `control closes ${c.control_close} in ${WINDOW_MIN} min, over 3x the previous window`
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
    breach: (c, min) => c.phone_open + c.control_active < min && c.refuse_4401 >= LOW_VOLUME_4401_MIN,
    describe: (c) => `4401 refusals ${c.refuse_4401} in ${WINDOW_MIN} min at low volume (${c.phone_open + c.control_active} hellos)`
  },
  {
    // Dead man: traffic stopped (the edge or its metrics went silent) after a window that had some.
    id: 'silent',
    breach: (c, min, prior) => prior !== undefined && prior.events >= min && c.events === 0,
    describe: () => `no edge events in ${WINDOW_MIN} min`
  }
]

async function window(env: AlertsEnv, fromMin: number, toMin: number): Promise<Counts> {
  const [counts, latency] = await Promise.all([
    query(env, SQL(env.DATASET, fromMin, toMin)),
    query(env, DB_P95_SQL(env.DATASET, fromMin, toMin))
  ])
  return { ...counts, ...latency }
}

async function query(env: AlertsEnv, sql: string): Promise<Counts> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AE_READ_TOKEN}` },
    body: sql
  })
  if (!response.ok) { throw new Error(`analytics query failed: ${response.status}`) }
  const row = ((await response.json()) as { data: Record<string, unknown>[] }).data[0] ?? {}
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]))
}

async function post(env: AlertsEnv, text: string): Promise<void> {
  await fetch(env.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `[relay-edge ${env.ENVIRONMENT}] ${text}` })
  })
}

export async function evaluate(env: AlertsEnv, scheduledTime: number): Promise<string[]> {
  if (!env.AE_READ_TOKEN || !env.ALERT_WEBHOOK_URL) {
    console.warn('relay-edge alerts: secrets not set; skipping')
    return []
  }
  const minVolume = Number(env.MIN_VOLUME ?? '200')
  const probeFailure = env.EDGE_PROBE_URL ? await probeEdge(env.EDGE_PROBE_URL) : null
  const probeAlert = probeFailure ? [`FIRING edge-probe: ${probeFailure}`] : []
  if (probeAlert.length > 0) { await post(env, probeAlert[0]) }
  let now: Counts
  let before: Counts
  try {
    // 2-min lag: Analytics Engine ingestion is not instant.
    ;[now, before] = await Promise.all([window(env, WINDOW_MIN + 2, 2), window(env, 2 * WINDOW_MIN + 2, WINDOW_MIN + 2)])
  } catch (error) {
    const text = `alerts cannot read metrics: ${(error as Error).message}`
    await post(env, text)
    return [...probeAlert, text]
  }
  const hourly = new Date(scheduledTime).getUTCMinutes() < 5
  const fired: string[] = []
  for (const rule of RULES) {
    if (!rule.breach(now, minVolume, before)) { continue }
    const started = !rule.breach(before, minVolume)
    if (started || hourly) { fired.push(`${started ? 'FIRING' : 'STILL FIRING'} ${rule.id}: ${rule.describe(now)}`) }
  }
  for (const text of fired) { await post(env, text) }
  return [...probeAlert, ...fired]
}

export default {
  async scheduled(controller: ScheduledController, env: AlertsEnv): Promise<void> {
    await evaluate(env, controller.scheduledTime)
  }
} satisfies ExportedHandler<AlertsEnv>
