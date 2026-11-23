// Wake alerts: its own instance of the relay edge's alerts cron Worker (relay-edge/src/alerts.ts),
// deployed apart from the wake Worker so it keeps running when that is broken, and apart from the
// edge's so a noisy wake alert never masks a relay one. Every 5 min it reads the wake dataset over
// the SQL API and posts to a webhook when a rule starts breaching (and hourly while it persists).
// Stateless: "starts breaching" = breaching now but not in the window the previous run (5 min ago)
// judged, rebuilt from the same per-minute counts. ALERTS_OFF names rules a deployment never runs.
// Secrets (stdin only): AE_READ_TOKEN (Account Analytics: Read), ALERT_WEBHOOK_URL (its own Slack
// webhook). Probes (EDGE_PROBE_URL): an unauthenticated wake upgrade must get 401, and the canary
// object must answer. Rules, thresholds and their env vars: alerts-rules.ts.
import { cloudflareErrors } from '../../relay-edge/src/alerts-cloudflare'
import { probeObject, probeUnauthenticatedUpgrade } from '../../relay-edge/src/alerts-probe'
import { CONNECTOR_WAKE_PATH } from '../../../packages/connector-contract/src/wake-messages'
import { RULES, SQL, WINDOW_MIN, thresholds, type Counts, type WakeAlertsEnv } from './alerts-rules'

export { RULES, type WakeAlertsEnv }

// Analytics Engine ingestion is not instant.
const LAG_MIN = 2
// The cron's period: the previous run judged windows this much older.
const RUN_EVERY_MIN = 5
const DEFAULT_SCRIPT_NAME = 'orca-connector-wake'

type Minute = { ago: number; counts: Counts }

async function minutes(env: WakeAlertsEnv, fromMin: number): Promise<Minute[]> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AE_READ_TOKEN}` },
    body: SQL(env.DATASET, fromMin)
  })
  if (!response.ok) { throw new Error(`analytics query failed: ${response.status}`) }
  const rows = ((await response.json()) as { data: Record<string, unknown>[] }).data
  return rows.map(({ ago, ...row }) => ({
    ago: Number(ago),
    counts: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]))
  }))
}

// The window from fromMin to toMin minutes ago, as the SQL's minutes count them. Every column is
// present, 0 in a window with no rows, so a rule can tell "none" from "unknown".
function window(rows: Minute[], fromMin: number, toMin: number): Counts {
  const sum: Counts = Object.fromEntries(rows.flatMap(({ counts }) => Object.keys(counts)).map((k) => [k, 0]))
  for (const { ago, counts } of rows) {
    if (ago < toMin || ago >= fromMin) { continue }
    for (const [k, v] of Object.entries(counts)) { sum[k] = (sum[k] ?? 0) + v }
  }
  return sum
}

// A window `endMin` minutes back and the one before it.
const pair = (rows: Minute[], endMin: number): [Counts, Counts] => [
  window(rows, endMin + WINDOW_MIN, endMin),
  window(rows, endMin + 2 * WINDOW_MIN, endMin + WINDOW_MIN)
]

function rulesOn(env: WakeAlertsEnv): typeof RULES {
  const off = new Set((env.ALERTS_OFF ?? '').split(',').map((id) => id.trim()).filter(Boolean))
  const unknown = [...off].filter((id) => !RULES.some((rule) => rule.id === id))
  if (unknown.length > 0) { console.warn(`connector-wake alerts: ALERTS_OFF names no rule: ${unknown.join(', ')}`) }
  return RULES.filter((rule) => !off.has(rule.id))
}

async function post(env: WakeAlertsEnv, text: string): Promise<void> {
  const response = await fetch(env.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `[connector-wake ${env.ENVIRONMENT}] ${text}` })
  })
  // Stateless, so a rejected post is not retried; the Worker's logs keep it.
  if (!response.ok) { console.error(`connector-wake alerts: webhook answered ${response.status}: ${text}`) }
}

async function probes(env: WakeAlertsEnv): Promise<string[]> {
  if (!env.EDGE_PROBE_URL) { return [] }
  const base = env.EDGE_PROBE_URL.replace(/\/+$/, '')
  const [edge, object] = await Promise.all([probeUnauthenticatedUpgrade(`${base}${CONNECTOR_WAKE_PATH}`, 'wake', Date.now), probeObject(base)])
  return [...(edge ? [`FIRING edge-probe: ${edge}`] : []), ...(object ? [`FIRING object-probe: ${object}`] : [])]
}

// Cloudflare's counts merged into each window; an unreadable API skips the rule and says so hourly.
// GraphQL gives this run's two windows only, so the previous run's window takes the earlier one.
async function withCloudflare(env: WakeAlertsEnv, now: Counts, before: Counts, previous: Counts, hourly: boolean): Promise<string | null> {
  try {
    // Never the edge's script, which is the shared module's default.
    const counts = await cloudflareErrors({ ...env, CF_SCRIPT_NAME: env.CF_SCRIPT_NAME || DEFAULT_SCRIPT_NAME }, WINDOW_MIN, LAG_MIN)
    if (counts) {
      Object.assign(now, counts[0])
      Object.assign(before, counts[1])
      Object.assign(previous, counts[1])
    }
    return null
  } catch (error) {
    return hourly ? `alerts cannot read Cloudflare analytics: ${(error as Error).message}` : null
  }
}

export async function evaluate(env: WakeAlertsEnv, scheduledTime: number): Promise<string[]> {
  if (!env.AE_READ_TOKEN || !env.ALERT_WEBHOOK_URL) {
    console.warn('connector-wake alerts: secrets not set; skipping')
    return []
  }
  const limits = thresholds(env)
  const probeAlerts = await probes(env)
  for (const text of probeAlerts) { await post(env, text) }
  let rows: Minute[]
  try {
    rows = await minutes(env, 2 * WINDOW_MIN + LAG_MIN + RUN_EVERY_MIN)
  } catch (error) {
    const text = `alerts cannot read metrics: ${(error as Error).message}`
    await post(env, text)
    return [...probeAlerts, text]
  }
  const [now, before] = pair(rows, LAG_MIN)
  const [previous, previousBefore] = pair(rows, LAG_MIN + RUN_EVERY_MIN)
  const hourly = new Date(scheduledTime).getUTCMinutes() < 5
  const unreadable = await withCloudflare(env, now, before, previous, hourly)
  const fired: string[] = unreadable ? [unreadable] : []
  for (const rule of rulesOn(env)) {
    if (!rule.breach(now, limits, before)) { continue }
    // As Alertmanager's repeat interval: once when it starts, then hourly while it holds.
    const started = !rule.breach(previous, limits, previousBefore)
    if (started || hourly) { fired.push(`${started ? 'FIRING' : 'STILL FIRING'} ${rule.id}: ${rule.describe(now, limits)}`) }
  }
  for (const text of fired) { await post(env, text) }
  return [...probeAlerts, ...fired]
}

export default {
  async scheduled(controller: ScheduledController, env: WakeAlertsEnv): Promise<void> {
    await evaluate(env, controller.scheduledTime)
  }
} satisfies ExportedHandler<WakeAlertsEnv>
