// Edge alerts: a separate cron Worker (wrangler.alerts.jsonc) so it keeps running when the edge
// itself is broken or mid-deploy. Every 5 min it reads the edge's Analytics Engine dataset over
// the SQL API and posts to a webhook when a rule starts breaching (and hourly while it persists).
// Stateless: "starts breaching" = breaching in the last window but not in the one before.
// Secrets (set from stdin, never in config or logs): AE_READ_TOKEN (Account Analytics: Read),
// ALERT_WEBHOOK_URL (Slack-compatible incoming webhook: POST {text}).
// Share rules need MIN_VOLUME hellos per window; the absolute-count rules (admin failures, 4401s
// below that volume), the reconnect surge floor and the synthetic probes (EDGE_PROBE_URL,
// alerts-probe.ts: the router's 401 and a canary object's storage read) also cover a quiet edge.
// Optional: Worker/Durable Object errors from Cloudflare's GraphQL API (alerts-cloudflare.ts).
// Rules, thresholds and their env vars: alerts-rules.ts.
import { probeEdge, probeObject } from './alerts-probe'
import { cloudflareErrors } from './alerts-cloudflare'
import { DB_P95_SQL, RULES, SQL, WINDOW_MIN, thresholds, type AlertsEnv, type Counts } from './alerts-rules'

export { ADMIN_SUCCESS_LABELS, RULES, type AlertsEnv } from './alerts-rules'

// Analytics Engine ingestion is not instant.
const LAG_MIN = 2

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

async function probes(env: AlertsEnv): Promise<string[]> {
  if (!env.EDGE_PROBE_URL) { return [] }
  const [edge, object] = await Promise.all([probeEdge(env.EDGE_PROBE_URL), probeObject(env.EDGE_PROBE_URL)])
  return [...(edge ? [`FIRING edge-probe: ${edge}`] : []), ...(object ? [`FIRING object-probe: ${object}`] : [])]
}

// Cloudflare's counts merged into each window; an unreadable API skips the rule and says so hourly.
async function withCloudflare(env: AlertsEnv, now: Counts, before: Counts, hourly: boolean): Promise<string | null> {
  try {
    const counts = await cloudflareErrors(env, WINDOW_MIN, LAG_MIN)
    if (counts) {
      Object.assign(now, counts[0])
      Object.assign(before, counts[1])
    }
    return null
  } catch (error) {
    return hourly ? `alerts cannot read Cloudflare analytics: ${(error as Error).message}` : null
  }
}

export async function evaluate(env: AlertsEnv, scheduledTime: number): Promise<string[]> {
  if (!env.AE_READ_TOKEN || !env.ALERT_WEBHOOK_URL) {
    console.warn('relay-edge alerts: secrets not set; skipping')
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
    if (started || hourly) { fired.push(`${started ? 'FIRING' : 'STILL FIRING'} ${rule.id}: ${rule.describe(now)}`) }
  }
  for (const text of fired) { await post(env, text) }
  return [...probeAlerts, ...fired]
}

export default {
  async scheduled(controller: ScheduledController, env: AlertsEnv): Promise<void> {
    await evaluate(env, controller.scheduledTime)
  }
} satisfies ExportedHandler<AlertsEnv>
