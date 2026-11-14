// Read-only: the zone features that could act on traffic concentrated on a few source addresses
// (a load-balancer front door reaches the edge from a handful of egress IPs). GET requests only,
// with the logged-in wrangler session; prints settings and rule shapes, never ids, tokens, rule
// expressions' literal values or IP lists.
//   npx tsx spike/zone-source-ip-audit.ts <a hostname in the zone, e.g. the edge's>
// The wrangler login's `zone (read)` scope lists zones only; settings, bot management and rulesets
// need a token with Zone Settings Read, Bot Management Read and Zone WAF Read (CLOUDFLARE_API_TOKEN).
import { execFileSync } from 'node:child_process'

const hostname = process.argv[2]
if (!hostname) throw new Error('usage: zone-source-ip-audit.ts <hostname in the zone>')
const token = process.env.CLOUDFLARE_API_TOKEN ?? execFileSync('npx', ['wrangler', 'auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  .split('\n')
  .map((l) => l.trim())
  .find((l) => /^[A-Za-z0-9._-]{30,}$/.test(l))
if (!token) throw new Error('no wrangler token (run `npx wrangler login`)')

type Api<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] }
async function get<T>(path: string): Promise<{ ok: true; result: T } | { ok: false; why: string }> {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}` } })
  const body = (await r.json().catch(() => null)) as Api<T> | null
  if (r.ok && body?.success) return { ok: true, result: body.result }
  return { ok: false, why: `${r.status} ${body?.errors?.map((e) => `${e.code}`).join(',') ?? ''}`.trim() }
}

const show = (label: string, value: unknown) => console.log(`${label.padEnd(44)} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
// Shape of a rule expression without its literals (IPs, hostnames, paths).
const fields = (expression = '') => [...new Set(expression.match(/\b(ip\.src[\w.]*|cf\.[\w.]+|http\.[\w.]+|ip\.geoip\.[\w.]+)/g) ?? [])].join(' ')

async function main(): Promise<void> {
  const zones = await get<{ id: string; name: string; plan?: { name?: string } }[]>('/zones?per_page=50')
  if (!zones.ok) throw new Error(`zones: ${zones.why}`)
  const zone = zones.result.filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0]
  if (!zone) throw new Error('no zone visible to this session contains that hostname')
  show('zone plan', zone.plan?.name ?? '?')
  const z = `/zones/${zone.id}`

  console.log('\n# Zone settings that act per source or per client')
  const settings = await get<{ id: string; value: unknown }[]>(`${z}/settings`)
  if (settings.ok) {
    const wanted = ['security_level', 'browser_check', 'challenge_ttl', 'waf', 'websockets', 'ip_geolocation', 'privacy_pass', 'replace_insecure_js', 'opportunistic_onion', 'max_upload', 'http2', 'http3', 'min_tls_version']
    for (const s of settings.result.filter((s) => wanted.includes(s.id))) show(s.id, s.value)
  } else show('settings', `unreadable (${settings.why})`)

  console.log('\n# Bot features')
  const bots = await get<Record<string, unknown>>(`${z}/bot_management`)
  if (bots.ok) {
    for (const [k, v] of Object.entries(bots.result)) if (!/id$/i.test(k)) show(`bot_management.${k}`, v)
  } else show('bot_management', `unreadable (${bots.why})`)

  console.log('\n# Rules (phase entrypoints): action, enabled, fields used; no literals')
  for (const phase of ['http_request_firewall_custom', 'http_ratelimit', 'http_request_firewall_managed', 'http_request_sbfm', 'ddos_l7', 'http_request_dynamic_redirect', 'http_config_settings']) {
    const ep = await get<{ rules?: { action?: string; enabled?: boolean; description?: string; expression?: string; ratelimit?: Record<string, unknown>; action_parameters?: Record<string, unknown> }[] }>(`${z}/rulesets/phases/${phase}/entrypoint`)
    if (!ep.ok) {
      show(phase, ep.why.startsWith('404') ? 'none' : `unreadable (${ep.why})`)
      continue
    }
    const rules = ep.result.rules ?? []
    show(phase, `${rules.length} rule(s)`)
    for (const rule of rules) {
      const rl = rule.ratelimit
      show(`  - ${rule.action}${rule.enabled === false ? ' (disabled)' : ''}`, `${rule.description ?? ''} | fields: ${fields(rule.expression)}${rl ? ` | ratelimit: by ${JSON.stringify(rl.characteristics)} ${rl.requests_per_period}/${rl.period}s mitigate ${rl.mitigation_timeout}s` : ''}${rule.action_parameters?.overrides ? ` | overrides: ${JSON.stringify(rule.action_parameters.overrides)}` : ''}`)
    }
  }

  console.log('\n# Legacy per-IP controls (counts only)')
  const access = await get<{ mode: string; configuration: { target: string } }[]>(`${z}/firewall/access_rules/rules?per_page=100`)
  if (access.ok) {
    const counts: Record<string, number> = {}
    for (const r of access.result) counts[`${r.mode}:${r.configuration.target}`] = (counts[`${r.mode}:${r.configuration.target}`] ?? 0) + 1
    show('IP access rules (zone)', counts)
  } else show('IP access rules (zone)', `unreadable (${access.why})`)
  for (const [label, path] of [['zone lockdown rules', 'firewall/lockdowns'], ['user-agent blocking rules', 'firewall/ua_rules']] as const) {
    const r = await get<unknown[]>(`${z}/${path}?per_page=100`)
    show(label, r.ok ? `${r.result.length}` : `unreadable (${r.why})`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
