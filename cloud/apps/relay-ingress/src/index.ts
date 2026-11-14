// Ingress proxy process: config from the environment, files for the secret and certificate.
//   INGRESS_NAME (metric label, e.g. cn), INGRESS_ORIGIN (https://cn.relay.<zone>), UPSTREAM_URL
//   (the edge Worker's https origin), INGRESS_SECRET_FILE (shared with the edge's INGRESS_SECRETS),
//   TLS_CERT_FILE / TLS_KEY_FILE, PORT (443), HOST (::), HEALTH_PORT (8081, GET /healthz, /stats),
//   HEALTH_HOST (127.0.0.1), IDLE_TIMEOUT_MS (300000, must exceed 120000), DRAIN_DELAY_MS (10000),
//   DRAIN_MS (30000), UPSTREAM_CA_FILE (local tests only: replaces the system trust store).
//   SIGTERM/SIGINT: drain (health 503, stop accepting, cut what is left after DRAIN_MS).
//   SIGHUP: reload the certificate files (run by the certificate renewal hook).
import { readFileSync } from 'node:fs'
import { createIngressProxy } from './proxy.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`relay_ingress_config_${name.toLowerCase()}`)
  return value
}
const int = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`relay_ingress_config_${name.toLowerCase()}`)
  return value
}
const readTls = () => ({ key: readFileSync(required('TLS_KEY_FILE')), cert: readFileSync(required('TLS_CERT_FILE')) })

const publicOrigin = new URL(required('INGRESS_ORIGIN')).origin
const upstream = new URL(required('UPSTREAM_URL'))
const secret = readFileSync(required('INGRESS_SECRET_FILE'), 'utf8').trim()
if (secret.length < 32) throw new Error('relay_ingress_config_secret')
if (upstream.protocol !== 'https:') throw new Error('relay_ingress_config_upstream_url')
const idleTimeoutMs = int('IDLE_TIMEOUT_MS', 300_000)
// Edge control pings arrive every 30 s, phones may idle longer; 120 s is the floor.
if (idleTimeoutMs <= 120_000) throw new Error('relay_ingress_config_idle_timeout_ms')

const proxy = createIngressProxy({
  name: required('INGRESS_NAME'),
  publicOrigin,
  upstream,
  secret,
  upstreamCa: process.env.UPSTREAM_CA_FILE ? readFileSync(process.env.UPSTREAM_CA_FILE) : undefined,
  tls: readTls(),
  idleTimeoutMs,
  drainDelayMs: int('DRAIN_DELAY_MS', 10_000),
  drainMs: int('DRAIN_MS', 30_000)
})
const port = int('PORT', 443)
const healthPort = int('HEALTH_PORT', 8081)
proxy.server.listen(port, process.env.HOST ?? '::', () => proxy.log({ event: 'listening', port, name: required('INGRESS_NAME') }))
proxy.health.listen(healthPort, process.env.HEALTH_HOST ?? '127.0.0.1')

const statsTimer = setInterval(() => proxy.log({ event: 'stats', ...proxy.stats }), 60_000)
statsTimer.unref()
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void proxy.drain().then(() => process.exit(0)))
}
process.on('SIGHUP', () => {
  try {
    proxy.reloadTls(readTls())
    proxy.log({ event: 'tls_reloaded' })
  } catch {
    proxy.log({ event: 'tls_reload_failed' })
  }
})
