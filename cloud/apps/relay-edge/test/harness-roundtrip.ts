// Shared constants and helpers for roundtrip.ts: the director and cell child processes, host
// JWTs, cell heartbeats, the shipped desktop control client and phone sockets.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, type KeyLike } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/transports/relay-transport'
import { RelayPhoneHelloSchema } from '../../../../src/shared/remote-runtime/relay/mobile-relay-phone-protocol'

export const DIRECTOR_APP = process.env.DIRECTOR_APP ?? ''
export const DATABASE_URL = process.env.DATABASE_URL ?? ''
export const EDGE_URL = (process.env.EDGE_URL ?? '').replace(/\/$/, '')
export const EDGE_KEY = readFileSync(process.env.EDGE_KEY_FILE ?? '', 'utf8').trim()
export const DIRECTOR_PORT = Number(process.env.DIRECTOR_PORT ?? 18480)
export const CELL_PORT = DIRECTOR_PORT + 1
export const JWKS_PORT = DIRECTOR_PORT + 2
export const DIRECTOR = `http://127.0.0.1:${DIRECTOR_PORT}`
export const CELL = `http://127.0.0.1:${CELL_PORT}`
export const ISSUER = `http://127.0.0.1:${JWKS_PORT}`
export const CELL_ID = 'rt-c1'
export const USER = `rt-user-${randomBytes(3).toString('hex')}`
export const ASSIGNMENT_KEY = randomBytes(36).toString('base64url')
export const CELL_STARTED_AT = Date.now()
export const CELL_INCARNATION = crypto.randomUUID()

export const results: { name: string; ok: boolean }[] = []
export function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const sha = (s: string) => createHash('sha256').update(s).digest('base64url')
export const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
export async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end && !cond()) { await sleep(25) }
  return cond()
}

export const box = nacl.box.keyPair()
export const host = {
  relayHostId: createHash('sha256').update(box.publicKey).digest('base64url').slice(0, 16),
  keypair: { publicKey: box.publicKey, secretKey: box.secretKey, publicKeyB64: Buffer.from(box.publicKey).toString('base64') }
}

let userKey: KeyLike
let adminKey: KeyLike
// The entry sets the keys once it has loaded them (user host-control JWTs; admin heartbeats).
export function setKeys(user: KeyLike, admin: KeyLike): void {
  userKey = user
  adminKey = admin
}

export async function mint(): Promise<string> {
  return new SignJWT({ purpose: 'host-control', prof: `prof-${USER}`, relayHostId: host.relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: 'spike' })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(userKey)
}

export async function heartbeat(): Promise<void> {
  const audience = `${DIRECTOR}/v1/admin/cell-heartbeat`
  const token = await new SignJWT({ email: 'deploy@example.com', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'admin-key' })
    .setIssuer('https://accounts.google.com')
    .setAudience(audience)
    .setSubject('deploy-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(adminKey)
  await fetch(audience, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      cellId: CELL_ID,
      cellUrl: CELL,
      cellIncarnation: CELL_INCARNATION,
      startedAt: CELL_STARTED_AT,
      ready: true,
      observedRequests: 0
    })
  })
    .then(async (r) => {
      if (!r.ok) { console.log(`heartbeat ${r.status} ${await r.text()}`) }
    })
    .catch((e: Error) => console.log(`heartbeat error ${e.message}`))
}

export const children: ChildProcess[] = []
export function relay(role: 'director' | 'cell', extra: Record<string, string> = {}): { child: ChildProcess; log: string[] } {
  const url = role === 'director' ? DIRECTOR : CELL
  const log: string[] = []
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DIRECTOR_APP,
    env: {
      ...process.env,
      PORT: new URL(url).port,
      DATABASE_URL,
      ORCA_RELAY_PUBLIC_URL: url,
      ORCA_RELAY_CELL_URL: url,
      ORCA_RELAY_CELL_ID: role === 'director' ? 'director' : CELL_ID,
      ORCA_RELAY_CELL_CAPACITY: '10',
      ORCA_RELAY_CELLS_JSON: JSON.stringify(role === 'director' ? [{ id: CELL_ID, url: CELL, capacityRequests: 10 }] : []),
      ORCA_RELAY_ROLE: role,
      ORCA_RELAY_AUTH_ISSUER: ISSUER,
      ORCA_RELAY_JWKS_URL: `${ISSUER}/jwks`,
      ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: ASSIGNMENT_KEY,
      ORCA_RELAY_DATA_DIR: mkdtempSync(join(tmpdir(), `rt-${role}-`)),
      ORCA_RELAY_ADMIN_AUDIENCE: `${url}/v1/admin/drain`,
      ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.com',
      ORCA_RELAY_MONITOR_SERVICE_ACCOUNT: 'monitor@example.com',
      ORCA_RELAY_FENCE_SERVICE_ACCOUNT: 'fence@example.com',
      ORCA_RELAY_FENCE_BROKER_SERVICE_ACCOUNT: 'broker@example.com',
      ORCA_RELAY_ADMIN_JWKS_URL: `${ISSUER}/jwks`,
      ...extra
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  for (const stream of [child.stdout, child.stderr]) { stream?.on('data', (d) => log.push(String(d))) }
  children.push(child)
  return { child, log }
}

export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) { return }
  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))
}

export async function ready(url: string, log: string[], marker?: string): Promise<void> {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const up = await fetch(`${url}/health`).then((r) => r.ok, () => false)
    if (up && (!marker || log.join('').includes(marker))) { return }
    await sleep(200)
  }
  throw new Error(`not ready: ${url}\n${log.join('').slice(-2000)}`)
}

export async function director(cohort: { allow?: boolean; deny?: boolean }) {
  const d = relay('director', {
    ORCA_RELAY_EDGE_CELL_URL: EDGE_URL,
    ORCA_RELAY_EDGE_ADMIN_SIGNING_KEY: EDGE_KEY,
    ORCA_RELAY_EDGE_ALLOW_HOSTS: cohort.allow ? host.relayHostId : '',
    ORCA_RELAY_EDGE_DENY_HOSTS: cohort.deny ? host.relayHostId : ''
  })
  await ready(DIRECTOR, d.log, 'orca_relay_edge_cell_ready')
  await heartbeat()
  return d
}

export async function assign(): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${DIRECTOR}/v1/assign`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await mint()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, relayHostId: host.relayHostId, preferredRegion: 'us-central1' })
  })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }
}

export function control(cellUrl: string, epoch: number, jwt: string) {
  const events = { closes: [] as number[], opens: [] as { connId: string }[] }
  let transport: CloudRelayTransport | null = null
  const client = new RelayControlClient({
    cellUrl,
    relayJwt: jwt,
    relayHostId: host.relayHostId,
    assignmentEpoch: epoch,
    identity: { userId: USER, profileId: `prof-${USER}`, organizationId: '' },
    keypair: host.keypair as never,
    appVersion: 'roundtrip',
    onConnectionOpen: (m) => {
      events.opens.push(m)
      void transport?.openConnection(m)
    },
    onDrain: () => {},
    onClose: (code) => events.closes.push(code),
    createSocket: (url, token) =>
      new WebSocket(url, {
        headers: { authorization: `Bearer ${token}`, 'x-orca-host-capabilities': 'pending-conn-details,idle-regional-rehome-v1' },
        perMessageDeflate: false,
        maxPayload: 64 * 1024
      })
  })
  return {
    client,
    events,
    attach(generation: number) {
      transport = new CloudRelayTransport({ cellUrl, relayHostId: host.relayHostId, generation })
      transport.onMessage(((m: string | Uint8Array, reply: (r: string | Uint8Array) => void) => reply(m)) as never)
    }
  }
}

export async function online(cellUrl: string, epoch: number) {
  const c = control(cellUrl, epoch, await mint())
  const ack = await c.client.connect()
  c.attach(ack.generation)
  return c
}

export async function phone(cellUrl: string, credential: string) {
  const ws = new WebSocket(`${cellUrl.replace(/^http/, 'ws')}/v1/connect/${host.relayHostId}`, { perMessageDeflate: false })
  const state = { hello: null as Record<string, unknown> | null, closed: null as number | null }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential })))
  ws.on('message', (raw) => {
    if (state.hello === null) { state.hello = JSON.parse(raw.toString()) }
  })
  ws.on('close', (code) => (state.closed = code))
  ws.on('error', () => {})
  await waitFor(() => state.hello !== null || state.closed !== null, 8000)
  return { ws, state }
}

// Pairs a new phone through an invite and installs its resume token; returns the token.
export async function pair(c: Awaited<ReturnType<typeof online>>, cellUrl: string, deviceId: string): Promise<string> {
  const invite = await c.client.createInvite(deviceId)
  const p = await phone(cellUrl, invite.inviteToken)
  const basisConnId = c.events.opens.at(-1)?.connId ?? ''
  const token = b64url(randomBytes(32))
  await c.client.installCredential({
    reqId: `install-${deviceId}`,
    relayDeviceId: deviceId,
    newResumeTokenHash: sha(token),
    authorization: { mode: 'relay-basis', basisConnId }
  })
  p.ws.close()
  return token
}

export const resumed = (p: Awaited<ReturnType<typeof phone>>) =>
  RelayPhoneHelloSchema.safeParse(p.state.hello).success && p.state.hello?.credentialKind === 'resume'

export async function closeControl(c: Awaited<ReturnType<typeof online>>): Promise<void> {
  c.client.closeNow()
  await sleep(1500)
}
