// Wake alerts: its own instance of the relay edge's alerts cron Worker (relay-edge/src/alerts.ts),
// deployed apart from the wake Worker so it keeps running when that is broken, and apart from the
// edge's so a noisy wake alert never masks a relay one. Every 5 min it reads the wake dataset over
// the SQL API. As Alertmanager: a rule posts FIRING when it breaches and is not already firing, STILL
// FIRING once an hour while it holds, and RESOLVED once when it stops. Which rules are firing lives in
// ALERT_STATE (one KV key), so a skipped run, a failed read or late data never loses an alert; without
// that binding every breaching run posts. ALERTS_OFF names rules a deployment never runs.
// Secrets (stdin only): AE_READ_TOKEN (Account Analytics: Read), ALERT_WEBHOOK_URL (its own Slack
// webhook). Probes (EDGE_PROBE_URL): an unauthenticated wake upgrade must get 401, and the canary
// object must answer. Rules, thresholds and their env vars: alerts-rules.ts.
import { cloudflareErrors } from '../../relay-edge/src/alerts-cloudflare'
import { probeObject, probeUnauthenticatedUpgrade } from '../../relay-edge/src/alerts-probe'
import { CONNECTOR_WAKE_PATH } from '../../../packages/connector-contract/src/wake-messages'
import { COLUMNS, RULES, SQL, WINDOW_MIN, thresholds, type Counts, type WakeAlertsEnv } from './alerts-rules'

export { RULES, type WakeAlertsEnv }

// Analytics Engine ingestion is not instant.
const LAG_MIN = 2
const REPEAT_MS = 60 * 60_000
const DEFAULT_SCRIPT_NAME = 'orca-connector-wake'
const STATE_KEY = 'firing'

type Minute = { ago: number; counts: Counts }
// Per firing rule: when it started and when it was last posted (epoch ms of the run's schedule).
type Firing = Record<string, { since: number; notified: number }>

async function minutes(env: WakeAlertsEnv, fromMin: number, atSec: number): Promise<Minute[]> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.AE_READ_TOKEN}` },
    body: SQL(env.DATASET, fromMin, atSec)
  })
  if (!response.ok) { throw new Error(`analytics query failed: ${response.status}`) }
  const rows = ((await response.json()) as { data: Record<string, unknown>[] }).data
  return rows.map(({ ago, ...row }) => ({
    ago: Number(ago),
    counts: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]))
  }))
}

// The window from fromMin to toMin minutes ago. Every column is present, 0 with no rows.
function window(rows: Minute[], fromMin: number, toMin: number): Counts {
  const sum: Counts = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, 0]))
  for (const { ago, counts } of rows) {
    if (ago < toMin || ago >= fromMin) { continue }
    for (const [k, v] of Object.entries(counts)) { sum[k] = (sum[k] ?? 0) + v }
  }
  return sum
}

function rulesOn(env: WakeAlertsEnv): typeof RULES {
  const off = new Set((env.ALERTS_OFF ?? '').split(',').map((id) => id.trim()).filter(Boolean))
  const unknown = [...off].filter((id) => !RULES.some((rule) => rule.id === id))
  if (unknown.length > 0) { console.warn(`connector-wake alerts: ALERTS_OFF names no rule: ${unknown.join(', ')}`) }
  return RULES.filter((rule) => !off.has(rule.id))
}

async function readFiring(env: WakeAlertsEnv): Promise<Firing | null> {
  if (!env.ALERT_STATE) { return null }
  return ((await env.ALERT_STATE.get(STATE_KEY, 'json')) as Firing | null) ?? {}
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

// Cloudflare's counts merged into both windows, anchored to the run's schedule like the SQL; an
// unreadable API skips the rule and says so hourly.
async function withCloudflare(env: WakeAlertsEnv, now: Counts, before: Counts, atMs: number, hourly: boolean): Promise<string | null> {
  try {
    // Never the edge's script, which is the shared module's default.
    const counts = await cloudflareErrors({ ...env, CF_SCRIPT_NAME: env.CF_SCRIPT_NAME || DEFAULT_SCRIPT_NAME }, WINDOW_MIN, LAG_MIN, atMs)
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
  let rows: Minute[]
  try {
    rows = await minutes(env, 2 * WINDOW_MIN + LAG_MIN, Math.floor(scheduledTime / 1000))
  } catch (error) {
    // Firing state is left as it was, so the next readable run carries on from it.
    const text = `alerts cannot read metrics: ${(error as Error).message}`
    await post(env, text)
    return [...probeAlerts, text]
  }
  const now = window(rows, WINDOW_MIN + LAG_MIN, LAG_MIN)
  const before = window(rows, 2 * WINDOW_MIN + LAG_MIN, WINDOW_MIN + LAG_MIN)
  const rules = rulesOn(env)
  const hourly = new Date(scheduledTime).getUTCMinutes() < 5
  const unreadable = rules.some((rule) => rule.id === 'cloudflare-errors')
    ? await withCloudflare(env, now, before, scheduledTime, hourly)
    : null
  const fired: string[] = unreadable ? [unreadable] : []
  const firing = await readFiring(env)
  const next: Firing = {}
  for (const rule of rules) {
    const was = firing?.[rule.id]
    if (!rule.breach(now, limits, before)) {
      if (was) { fired.push(`RESOLVED ${rule.id}`) }
      continue
    }
    if (!was) {
      fired.push(`FIRING ${rule.id}: ${rule.describe(now, limits)}`)
      next[rule.id] = { since: scheduledTime, notified: scheduledTime }
    } else if (scheduledTime - was.notified >= REPEAT_MS) {
      fired.push(`STILL FIRING ${rule.id}: ${rule.describe(now, limits)}`)
      next[rule.id] = { since: was.since, notified: scheduledTime }
    } else {
      next[rule.id] = was
    }
  }
  for (const text of fired) { await post(env, text) }
  // After the posts: a failed write repeats a post next run rather than losing one.
  if (env.ALERT_STATE && JSON.stringify(next) !== JSON.stringify(firing)) {
    await env.ALERT_STATE.put(STATE_KEY, JSON.stringify(next))
  }
  return [...probeAlerts, ...fired]
}

export default {
  async scheduled(controller: ScheduledController, env: WakeAlertsEnv): Promise<void> {
    await evaluate(env, controller.scheduledTime)
  }
} satisfies ExportedHandler<WakeAlertsEnv>
