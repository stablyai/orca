// Local end to end: the edge Worker (wrangler dev over https, object backend) behind the ingress
// proxy (apps/relay-ingress) on localhost with a throwaway self-signed certificate. Drives the
// SHIPPED desktop control client and data transport, and phone-like sockets, through the proxy.
//   pnpm --filter @orca-cloud/relay-contract build && npx tsx test/ingress-e2e.ts
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { get as httpsGet } from 'node:https'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { RelayRetrySchedule } from '../../../../src/main/runtime/mobile-cloud-relay/relay-retry-schedule'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/relay-transport'

const EDGE_PORT = 8789
const PROXY_PORT = 8443
const EDGE = `https://127.0.0.1:${EDGE_PORT}`
// A different origin from the edge's: the host proof only verifies if the edge binds this one.
const INGRESS = `https://localhost:${PROXY_PORT}`
const SECRET = randomBytes(32).toString('base64url')
const SIGNING_KEY = randomBytes(36).toString('base64url')
const DIRECTOR = 'https://director.test.invalid'
const ISSUER = 'https://auth.test.invalid'
const EPOCH = 3
const USER = 'user-ingress'

// NODE_EXTRA_CA_CERTS is read at start-up: make the certificate, then run again trusting it.
if (!process.env.INGRESS_E2E_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-ingress-e2e-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
  const child = spawn(process.execPath, process.execArgv.concat(process.argv.slice(1)), {
    stdio: 'inherit',
    env: { ...process.env, INGRESS_E2E_DIR: dir, NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem') }
  })
  child.on('exit', (code) => {
    rmSync(dir, { recursive: true, force: true })
    process.exit(code ?? 1)
  })
} else {
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

const DIR = process.env.INGRESS_E2E_DIR ?? ''
const results: { name: string; ok: boolean; detail: string }[] = []
function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (s: string) => createHash('sha256').update(s).digest('base64url')
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

type Host = { relayHostId: string; keypair: { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyB64: string } }
function newHost(): Host {
  const box = nacl.box.keyPair()
  return {
    relayHostId: createHash('sha256').update(box.publicKey).digest('base64url').slice(0, 16),
    keypair: { publicKey: box.publicKey, secretKey: box.secretKey, publicKeyB64: Buffer.from(box.publicKey).toString('base64') }
  }
}

function mint(key: KeyLike, relayHostId: string): Promise<string> {
  return new SignJWT({ purpose: 'host-control', prof: `prof-${USER}`, relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: 'e2e' })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key)
}

// The desktop: shipped control client + shipped data transport, echoing every phone frame.
function desktop(cellUrl: string, host: Host, jwt: string, resume?: { previousGeneration: number; controlResumeSecret?: string }) {
  const events = { closes: [] as number[], lastConnId: '' }
  let transport: CloudRelayTransport | null = null
  const client = new RelayControlClient({
    cellUrl,
    relayJwt: jwt,
    relayHostId: host.relayHostId,
    assignmentEpoch: EPOCH,
    identity: { userId: USER, profileId: `prof-${USER}`, organizationId: '' },
    keypair: host.keypair as never,
    appVersion: 'ingress-e2e',
    ...resume,
    onConnectionOpen: (m) => {
      events.lastConnId = m.connId
      void transport?.openConnection(m).catch(() => {})
    },
    onDrain: () => {},
    onClose: (code) => events.closes.push(code),
    createSocket: (url, token) =>
      new WebSocket(url, { headers: { authorization: `Bearer ${token}`, 'x-orca-host-capabilities': 'pending-conn-details' }, perMessageDeflate: false, maxPayload: 1024 * 1024 + 1024 })
  })
  return {
    client,
    events,
    async connect() {
      const ack = await client.connect()
      transport = new CloudRelayTransport({ cellUrl, relayHostId: host.relayHostId, generation: ack.generation })
      transport.onMessage(((m: string | Uint8Array, reply: (r: string | Uint8Array) => void) => reply(m)) as never)
      return ack
    }
  }
}

// A phone-like socket: auth frame, then the relay hello, then raw frames.
function phone(origin: string, relayHostId: string, credential: string) {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/connect/${relayHostId}`, { perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 })
  const state = { hello: null as Record<string, unknown> | null, frames: [] as Buffer[], closed: null as number | null, closedAt: 0 }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential })))
  ws.on('message', (raw) => {
    if (state.hello === null) state.hello = JSON.parse(raw.toString())
    else state.frames.push(raw as Buffer)
  })
  ws.on('close', (code) => {
    state.closed = code
    state.closedAt = Date.now()
  })
  ws.on('error', () => {})
  return { ws, state }
}
async function phoneHello(origin: string, relayHostId: string, credential: string) {
  const p = phone(origin, relayHostId, credential)
  await waitFor(() => p.state.hello !== null || p.state.closed !== null, 8000)
  return p
}

async function adminAssign(relayHostId: string, devices: unknown[] = []) {
  const raw = JSON.stringify({ userId: USER, relayHostId, cellId: 'edge', assignmentEpoch: EPOCH, devices })
  const token = await new SignJWT({ purpose: 'edge-admin', op: 'assign', bodySha256: sha(raw) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(DIRECTOR)
    .setAudience('orca-relay-edge-admin')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(SIGNING_KEY))
  // The director talks to the edge directly; the ingress refuses admin paths.
  const r = await fetch(`${EDGE}/__admin/assign`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: raw })
  return (await r.json()) as { outcome?: string }
}

// Pre-auth probe: a plain GET to the phone route is admitted (426) or limited (429).
function preauthStatus(origin: string, relayHostId: string): Promise<number> {
  return new Promise((resolve) => {
    httpsGet(`${origin}/v1/connect/${relayHostId}`, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', () => resolve(-1))
  })
}

function startProxy(port: number, secret: string): { child: ChildProcess; log: () => string } {
  writeFileSync(join(DIR, `secret-${port}`), secret)
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../../relay-ingress/src/index.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      INGRESS_NAME: 'cn',
      INGRESS_ORIGIN: `https://localhost:${port}`,
      UPSTREAM_URL: EDGE,
      UPSTREAM_CA_FILE: join(DIR, 'cert.pem'),
      INGRESS_SECRET_FILE: join(DIR, `secret-${port}`),
      TLS_KEY_FILE: join(DIR, 'key.pem'),
      TLS_CERT_FILE: join(DIR, 'cert.pem'),
      PORT: String(port),
      HEALTH_PORT: String(port + 1),
      DRAIN_DELAY_MS: '500',
      DRAIN_MS: '2000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout?.on('data', (d) => (out += d))
  child.stderr?.on('data', (d) => (out += d))
  return { child, log: () => out }
}
async function ready(url: string, ms = 60_000): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      if ((await fetch(url)).ok) return Date.now() - started
    } catch {}
    await sleep(20)
  }
  throw new Error(`not ready: ${url}`)
}
const exited = (child: ChildProcess) => new Promise<void>((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', () => r())))

async function main(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'ES256', use: 'sig' }
  const jwks = createServer((_req, res) => res.setHeader('content-type', 'application/json').end(JSON.stringify({ keys: [jwk] })))
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', () => r()))
  writeFileSync(
    new URL('../.dev.vars', import.meta.url),
    [
      'EDGE_BACKEND=object',
      `ADMIN_SIGNING_KEY=${SIGNING_KEY}`,
      `ADMIN_ISSUER=${DIRECTOR}`,
      `RELAY_JWKS_URL=http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks`,
      `RELAY_AUTH_ISSUER=${ISSUER}`,
      `INGRESS_SECRETS=${SECRET}`,
      'PING_INTERVAL_MS=3000',
      'SILENCE_TIMEOUT_MS=9000',
      'ORPHAN_GRACE_MS=8000'
    ].join('\n')
  )
  const stateDir = mkdtempSync(join(tmpdir(), 'relay-edge-ingress-state-'))
  const dev = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(EDGE_PORT), '--ip', '127.0.0.1', '--persist-to', stateDir, '--local-protocol', 'https',
      '--https-key-path', join(DIR, 'key.pem'), '--https-cert-path', join(DIR, 'cert.pem')],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let devLog = ''
  dev.stdout?.on('data', (d) => (devLog += d))
  dev.stderr?.on('data', (d) => (devLog += d))
  let proxy = startProxy(PROXY_PORT, SECRET)
  const wrong = startProxy(PROXY_PORT + 10, randomBytes(32).toString('base64url'))
  try {
    await ready(`${EDGE}/health`, 90_000)
    await ready(`${INGRESS}/health`)
    await ready(`https://localhost:${PROXY_PORT + 10}/health`)
    proxy = await scenarios(privateKey, proxy)
  } catch (error) {
    console.error(error)
    console.error(devLog.split('\n').filter((l) => /error|exception/i.test(l)).slice(-20).join('\n'))
    console.error(proxy.log())
    process.exitCode = 1
  } finally {
    proxy.child.kill('SIGKILL')
    wrong.child.kill('SIGKILL')
    dev.kill('SIGINT')
    jwks.close()
    await sleep(500)
    rmSync(stateDir, { recursive: true, force: true })
  }
  const logs = proxy.log() + wrong.log()
  record('proxy logs carry no address, path or token', !/127\.0\.0\.1|::1|\/v1\/|Bearer|eyJ/.test(logs), `${logs.split('\n').filter(Boolean).length} lines`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

async function scenarios(key: KeyLike, proxy: ReturnType<typeof startProxy>): Promise<ReturnType<typeof startProxy>> {
  const host = newHost()
  const id = host.relayHostId
  const jwt = await mint(key, id)
  record('director push straight to the edge', (await adminAssign(id)).outcome === 'applied')

  // 1. Host proof binds the origin the desktop dialled.
  const direct = desktop(EDGE, host, jwt)
  const directAck = await direct.connect().catch((e: Error) => e)
  record('direct to the edge (no ingress header): host proof ok, as today', !(directAck instanceof Error), directAck instanceof Error ? directAck.message : `generation=${directAck.generation}`)
  direct.client.closeNow()
  const unsigned = desktop(`https://localhost:${PROXY_PORT + 10}`, host, jwt)
  const unsignedAck = await unsigned.connect().catch((e: Error) => e)
  record(
    'via an ingress whose secret the edge does not hold: header ignored, edge binds its own origin, desktop refuses the proof',
    unsignedAck instanceof Error && /invalid host challenge/.test(unsignedAck.message),
    unsignedAck instanceof Error ? unsignedAck.message.slice(0, 90) : 'connected?!'
  )
  unsigned.client.closeNow()
  await sleep(300)
  const main = desktop(INGRESS, host, jwt)
  const ack = await main.connect()
  record('via the ingress: host proof over the ingress origin succeeds (shipped client)', ack.generation >= 1, `generation=${ack.generation}`)

  // 2. Data flows: pair a phone through the ingress, then frames both ways through two hops.
  const invite = await main.client.createInvite('phone-a')
  const invitePhone = await phoneHello(INGRESS, id, invite.inviteToken)
  record('phone invite via the ingress: relay-hello ok', invitePhone.state.hello?.ok === true, JSON.stringify(invitePhone.state.hello))
  const resumeToken = randomBytes(32).toString('base64url')
  const installed = await main.client
    .installCredential({ reqId: 'i1', relayDeviceId: 'phone-a', newResumeTokenHash: sha(resumeToken), authorization: { mode: 'relay-basis', basisConnId: main.events.lastConnId } })
    .catch((e: Error) => e)
  record('credential install over the ingress control socket', !(installed instanceof Error), installed instanceof Error ? installed.message : '')
  // The shipped desktop data socket accepts frames up to 1 MiB.
  const sizes = [32, 64 * 1024, 1024 * 1024]
  const started = Date.now()
  for (const size of sizes) invitePhone.ws.send(randomBytes(size))
  await waitFor(() => invitePhone.state.frames.length === sizes.length, 15_000)
  record(
    'phone ↔ desktop frames echo through ingress + edge splice unchanged (32 B, 64 KiB, 1 MiB)',
    invitePhone.state.frames.map((f) => f.length).join() === sizes.join(),
    `echoed=${invitePhone.state.frames.map((f) => f.length).join('/')} in ${Date.now() - started} ms`
  )
  invitePhone.ws.close(4000, 'phone done')
  await waitFor(() => invitePhone.state.closed !== null, 3000)

  // 3. Close codes from the edge reach the client unchanged.
  const unknown = await phoneHello(INGRESS, id, randomBytes(32).toString('base64url'))
  await waitFor(() => unknown.state.closed !== null, 3000)
  const stray = await phoneHello(INGRESS, newHost().relayHostId, randomBytes(32).toString('base64url'))
  await waitFor(() => stray.state.closed !== null, 3000)
  const big = new WebSocket(`${INGRESS.replace('https', 'wss')}/v1/host/control`, { headers: { authorization: `Bearer ${jwt}` }, perMessageDeflate: false })
  big.on('error', () => {})
  const bigCode = await new Promise<number>((res) => {
    big.on('open', () => big.send('x'.repeat(1024 * 1024 + 1)))
    big.on('close', (c) => res(c))
    setTimeout(() => res(-1), 8000)
  })
  const noJwt = await new Promise<number>((res) => {
    const ws = new WebSocket(`${INGRESS.replace('https', 'wss')}/v1/host/control`)
    ws.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0))
    ws.on('error', () => res(-1))
  })
  record(
    'close codes through the ingress: unknown credential 4401, unpushed host 4409, control frame > 1 MiB 1009; 401 before upgrade',
    unknown.state.closed === 4401 && stray.state.closed === 4409 && bigCode === 1009 && noJwt === 401,
    `${unknown.state.closed}/${stray.state.closed}/${bigCode}/${noJwt}`
  )

  // 4. Pre-auth limits key on the client the ingress saw (127.0.0.1 vs ::1), not on the proxy.
  const probeHost = newHost().relayHostId
  const fromV4: number[] = []
  for (let i = 0; i < 65; i++) fromV4.push(await preauthStatus(`https://127.0.0.1:${PROXY_PORT}`, probeHost))
  const fromV6 = await preauthStatus(`https://[::1]:${PROXY_PORT}`, probeHost)
  record(
    'pre-auth: one client past the limit gets 429, another client behind the same ingress is still admitted',
    fromV4.includes(426) && fromV4.at(-1) === 429 && fromV6 === 426,
    `v4 first=${fromV4[0]} limitedFrom=${fromV4.indexOf(429)} last=${fromV4.at(-1)}; v6=${fromV6}`
  )

  // 5. Proxy restart: graceful (SIGTERM drain), crash (SIGKILL), and crash with the box down 6 s
  // (a VM replacement is slower still). Desktop reconnects with the shipped retry schedule; the
  // phone retries every 500 ms.
  let current = main
  for (const [mode, downMs] of [['SIGTERM', 0], ['SIGKILL', 0], ['SIGKILL', 6000]] as const) {
    const live = await phoneHello(INGRESS, id, resumeToken)
    const hadPhone = live.state.hello?.ok === true
    const closesBefore = current.events.closes.length
    const killedAt = Date.now()
    proxy.child.kill(mode)
    await waitFor(() => current.events.closes.length > closesBefore && (!hadPhone || live.state.closed !== null), 10_000)
    const desktopSaw = current.events.closes.at(-1)
    const cutAfter = Date.now() - killedAt
    console.log(`  ${mode}: desktop saw ${desktopSaw}, phone saw ${live.state.closed} at +${cutAfter} ms`)
    await exited(proxy.child)
    // Dials made while the box is down fail fast (connection refused) and back off.
    const schedule = new RelayRetrySchedule()
    let attempts = 0
    const back = new Promise<{ client: ReturnType<typeof desktop>; ms: number }>((resolve, reject) => {
      const attempt = () => {
        if (Date.now() - killedAt > 90_000) return reject(new Error(`desktop did not recover after ${attempts} dials`))
        attempts++
        const next = desktop(INGRESS, host, jwt)
        next.connect().then(
          () => resolve({ client: next, ms: Date.now() - killedAt }),
          () => schedule.schedule(0, attempt)
        )
      }
      schedule.schedule(0, attempt)
    })
    await sleep(downMs)
    const restartAt = Date.now()
    proxy = startProxy(PROXY_PORT, SECRET)
    const readyIn = await ready(`${INGRESS}/health`)
    const recovered = await back
    current.client.closeNow()
    current = recovered.client
    let phoneBack = -1
    for (let i = 0; i < 40 && phoneBack < 0; i++) {
      const p = await phoneHello(INGRESS, id, resumeToken)
      if (p.state.hello?.ok === true) {
        phoneBack = Date.now() - killedAt
        p.ws.close()
      } else await sleep(500)
    }
    record(
      `proxy ${mode}${downMs ? ` + ${downMs / 1000} s down` : ''}: clients see a close, then recover through the restarted proxy`,
      desktopSaw !== undefined && recovered.ms > 0 && phoneBack > 0,
      `phone open before=${hadPhone}; desktop close=${desktopSaw} phone close=${live.state.closed} at +${cutAfter} ms; proxy started at +${restartAt - killedAt} ms, ready in ${readyIn} ms; desktop active again at +${recovered.ms} ms (${attempts} dials); phone admitted at +${phoneBack} ms`
    )
  }
  current.client.closeNow()
  return proxy
}
