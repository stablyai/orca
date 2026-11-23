// Wake alerts: its own instance of the relay edge's alerts cron Worker (relay-edge/src/alerts.ts),
// deployed apart from the wake Worker so it keeps running when that is broken, and apart from the
// edge's so a noisy wake alert never masks a relay one. Every 5 min it reads the wake dataset over
// the SQL API and posts to a webhook when a rule starts breaching (and hourly while it persists).
// Stateless: "starts breaching" = breaching in the last window but not in the one before.
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
const DEFAULT_SCRIPT_NAME = 'orca-connector-wake'

async function window(env: WakeAlertsEnv, fromMin: number, toMin: number): Promise<Counts> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AE_READ_TOKEN}` },
    body: SQL(env.DATASET, fromMin, toMin)
  })
  if (!response.ok) { throw new Error(`analytics query failed: ${response.status}`) }
  const row = ((await response.json()) as { data: Record<string, unknown>[] }).data[0] ?? {}
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]))
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
async function withCloudflare(env: WakeAlertsEnv, now: Counts, before: Counts, hourly: boolean): Promise<string | null> {
  try {
    // Never the edge's script, which is the shared module's default.
    const counts = await cloudflareErrors({ ...env, CF_SCRIPT_NAME: env.CF_SCRIPT_NAME || DEFAULT_SCRIPT_NAME }, WINDOW_MIN, LAG_MIN)
    if (counts) {
      Object.assign(now, counts[0])
      Object.assign(before, counts[1])
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
  let now: Counts
  let before: Counts
  try {
    ;[now, before] = await Promise.all([window(env, WINDOW_MIN + LAG_MIN, LAG_MIN), window(env, 2 * WINDOW_MIN + LAG_MIN, WINDOW_MIN + LAG_MIN)])
  } catch (error) {
    const text = `alerts cannot read metrics: ${(error as Error).message}`
    await post(env, text)
    return [...probeAlerts, text]
  }
  const hourly = new Date(scheduledTime).getUTCMinutes() < 5
  const unreadable = await withCloudflare(env, now, before, hourly)
  const fired: string[] = unreadable ? [unreadable] : []
  for (const rule of RULES) {
    if (!rule.breach(now, limits, before)) { continue }
    const started = !rule.breach(before, limits)
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
