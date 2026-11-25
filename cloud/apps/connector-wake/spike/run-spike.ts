// Spike harness (design §5.2): answers W1 (wake latency), W4 (drops during a deploy), W5 (load
// for the cost extrapolation) and W7 (object placement) against a spike Worker on workers.dev.
// Test keys only (spike/.keys.json, gitignored). Synthetic hosts use the desktop's socket
// behaviour (test/wake-client.ts).
//   tsx spike/run-spike.ts jwks | wrangler secret put WAKE_JWKS
//   tsx spike/run-spike.ts admin-key | wrangler secret put WAKE_ADMIN_KEY
//   (vars: WAKE_ADMIN_ISSUER=https://spike.invalid, SPIKE_DEBUG=1, and an empty WAKE_REFUSE_COUNTRIES
//    only if the run is from a refused country)
//   SPIKE_URL=https://<worker>.workers.dev tsx spike/run-spike.ts latency --hosts 20 --rounds 50
//   SPIKE_URL=... tsx spike/run-spike.ts load --hosts 1000 --minutes 20   (deploy during it for W4)
//   SPIKE_URL=... tsx spike/run-spike.ts place
//   tsx spike/run-spike.ts local     every check once against local `wrangler dev`
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose'
import { adminWake, killAllDev, mintWake, newHost, sleep, startDev, waitFor, type Host, type SigningKey } from '../test/harness'
import { dialWake, type WakeSocket } from '../test/wake-client'

const SPIKE_ISSUER = 'https://spike.invalid'
type SpikeKeys = { privateJwk: JWK; publicJwk: JWK; adminKey: string }
const KEYS_PATH = new URL('./.keys.json', import.meta.url)

async function loadKeys(): Promise<SpikeKeys> {
  if (existsSync(KEYS_PATH)) { return JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as SpikeKeys }
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const keys: SpikeKeys = {
    privateJwk: { ...(await exportJWK(privateKey)), kid: 'spike', alg: 'ES256' },
    publicJwk: { ...(await exportJWK(publicKey)), kid: 'spike', alg: 'ES256', use: 'sig' },
    adminKey: randomBytes(36).toString('base64url')
  }
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 })
  return keys
}

// A positive integer option; the fallback only when the option is absent.
function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) { return fallback }
  const value = Number(process.argv[i + 1])
  if (!Number.isSafeInteger(value) || value <= 0) { throw new Error(`--${name} needs a positive integer`) }
  return value
}

function pct(values: number[], p: number): number {
  if (values.length === 0) { return Number.NaN }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

type Ctx = { origin: string; key: SigningKey; admin: { key: string; issuer: string } }
const emit = (event: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }))

async function connectAll(ctx: Ctx, hosts: Host[], keepaliveMs?: number): Promise<WakeSocket[]> {
  const sockets: WakeSocket[] = []
  // Ramped, so the spike measures sockets and not a connect storm.
  for (const h of hosts) {
    sockets.push(dialWake(ctx.origin, await mintWake(ctx.key, h, { kid: 'spike', expiresIn: '10m' }), { keepaliveMs }))
    if (sockets.length % 50 === 0) { await sleep(250) }
  }
  await waitFor(() => sockets.every((s) => s.state.open || s.state.closed || s.state.refused), 30_000)
  return sockets
}

// W1: admin wake sent → frame at the desktop, p50/p95, from this machine's location.
async function latency(ctx: Ctx, hostCount: number, rounds: number): Promise<void> {
  const hosts = Array.from({ length: hostCount }, () => newHost())
  const sockets = await connectAll(ctx, hosts)
  const ms: number[] = []
  for (let r = 0; r < rounds; r++) {
    const target = r % hosts.length
    const before = sockets[target].state.wakes.length
    const sentAt = Date.now()
    await adminWake(ctx.origin, [hosts[target].hostId], ctx.admin)
    // A timed-out round's late frame would pass for the next round's: stop instead.
    if (!(await waitFor(() => sockets[target].state.wakes.length > before, 5000))) {
      emit({ check: 'W1', error: 'wake not received within 5 s', round: r })
      process.exitCode = 1
      break
    }
    ms.push(sockets[target].state.wakes.at(-1)! - sentAt)
    await sleep(200)
  }
  emit({ check: 'W1', rounds, received: ms.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), open: sockets.filter((s) => s.state.open).length })
  for (const s of sockets) { s.close() }
}

// W4/W5: N idle sockets at the desktop keepalive cadence, one batched wake a minute. Deploy the
// Worker (staged, deferred) during the run: idleHostDrops must stay 0.
async function load(ctx: Ctx, hostCount: number, minutes: number): Promise<void> {
  const hosts = Array.from({ length: hostCount }, () => newHost())
  const sockets = await connectAll(ctx, hosts)
  emit({ check: 'W4', phase: 'connected', open: sockets.filter((s) => s.state.open).length, refused: sockets.filter((s) => s.state.refused).length })
  const end = Date.now() + minutes * 60_000
  while (Date.now() < end) {
    await sleep(60_000)
    let delivered = 0
    for (let i = 0; i < hosts.length; i += 500) {
      const res = await adminWake(ctx.origin, hosts.slice(i, i + 500).map((h) => h.hostId), ctx.admin)
      delivered += (res.json as { delivered?: number } | null)?.delivered ?? 0
    }
    const drops: Record<string, number> = {}
    for (const s of sockets) { if (s.state.closed) { drops[s.state.closed.code] = (drops[s.state.closed.code] ?? 0) + 1 } }
    emit({ check: 'W4', open: sockets.filter((s) => s.state.open).length, idleHostDrops: Object.values(drops).reduce((a, b) => a + b, 0), drops, delivered, acks: sockets.reduce((a, s) => a + s.state.acks, 0) })
  }
  for (const s of sockets) { s.close() }
}

async function objectPlace(ctx: Ctx, h: Host): Promise<Record<string, unknown>> {
  const response = await fetch(`${ctx.origin}/__spike/object/${encodeURIComponent(h.hostId)}`)
  return response.ok ? ((await response.json()) as Record<string, unknown>) : { status: response.status }
}

// W7: (a) a wake to a host that never connected creates an object near the publisher (here);
// (b) a wake racing the first connect; (c) the same host after its object was evicted (idle).
async function place(ctx: Ctx): Promise<void> {
  const never = newHost()
  const woke = await adminWake(ctx.origin, [never.hostId], ctx.admin)
  emit({ check: 'W7a', wake: woke.json, object: await objectPlace(ctx, never) })
  const raced = newHost()
  const [wake, socket] = await Promise.all([adminWake(ctx.origin, [raced.hostId], ctx.admin), connectAll(ctx, [raced])])
  emit({ check: 'W7b', wake: wake.json, object: await objectPlace(ctx, raced) })
  socket[0].close()
  // Objects with no socket and no requests are evicted after ~70-140 s of idleness.
  await sleep(180_000)
  emit({ check: 'W7c', object: await objectPlace(ctx, raced) })
}

async function main(): Promise<void> {
  const keys = await loadKeys()
  const cmd = process.argv[2] ?? 'local'
  if (cmd === 'jwks') { return void process.stdout.write(JSON.stringify({ keys: [keys.publicJwk] })) }
  if (cmd === 'admin-key') { return void process.stdout.write(keys.adminKey) }
  const key = (await importJWK(keys.privateJwk, 'ES256')) as SigningKey
  const admin = { key: keys.adminKey, issuer: SPIKE_ISSUER }
  if (cmd === 'local') {
    const dev = await startDev({ WAKE_JWKS: `'${JSON.stringify({ keys: [keys.publicJwk] })}'`, WAKE_ADMIN_KEY: keys.adminKey, WAKE_ADMIN_ISSUER: SPIKE_ISSUER, SPIKE_DEBUG: '1' })
    try {
      const ctx = { origin: dev.origin, key, admin }
      await latency(ctx, 5, 10)
      await load(ctx, 20, 1)
      const never = newHost()
      await adminWake(ctx.origin, [never.hostId], admin)
      emit({ check: 'W7a', object: await objectPlace(ctx, never) })
    } finally {
      await dev.stop()
    }
    return
  }
  const origin = process.env.SPIKE_URL?.replace(/\/$/, '')
  if (!origin) { throw new Error('SPIKE_URL is required') }
  const ctx = { origin, key, admin }
  if (cmd === 'latency') { return latency(ctx, arg('hosts', 20), arg('rounds', 50)) }
  if (cmd === 'load') { return load(ctx, arg('hosts', 1000), arg('minutes', 20)) }
  if (cmd === 'place') { return place(ctx) }
  throw new Error(`unknown command ${cmd}`)
}

const overall = setTimeout(() => {
  console.error('overall timeout (3 h)')
  killAllDev()
  process.exit(1)
}, 3 * 60 * 60 * 1000)
await main()
clearTimeout(overall)
process.exit(process.exitCode ?? 0)
