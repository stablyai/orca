// Phase 2 round trip with the real pieces: the director and a GCE-style cell (the relay app from
// the director branch, as child processes on one Postgres), the deployed phase-2 edge Worker, and
// the SHIPPED desktop control client and phone parser. A host pairs a phone on the cell, moves to
// the edge (director pushes its devices), pairs another phone and revokes the first there, then
// moves back (director exports, writes Postgres, places it on the cell, fences the edge).
//   DIRECTOR_APP=<orca worktree>/cloud/apps/relay DATABASE_URL=postgres://... \
//   EDGE_URL=https://<phase2 worker> EDGE_KEY_FILE=<admin key file> npx tsx test/roundtrip.ts
// The edge's ADMIN_ISSUER must be the local director origin (DIRECTOR_PORT, default 18480).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair, importJWK, type KeyLike } from 'jose'
import nacl from 'tweetnacl'
import pg from 'pg'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/relay-transport'
import { RelayPhoneHelloSchema } from '../../../../src/shared/mobile-relay-phone-protocol'
import { loadOrCreateKeys } from '../spike/lib'

const DIRECTOR_APP = process.env.DIRECTOR_APP ?? ''
const DATABASE_URL = process.env.DATABASE_URL ?? ''
const EDGE_URL = (process.env.EDGE_URL ?? '').replace(/\/$/, '')
const EDGE_KEY = readFileSync(process.env.EDGE_KEY_FILE ?? '', 'utf8').trim()
const DIRECTOR_PORT = Number(process.env.DIRECTOR_PORT ?? 18480)
const CELL_PORT = DIRECTOR_PORT + 1
const JWKS_PORT = DIRECTOR_PORT + 2
const DIRECTOR = `http://127.0.0.1:${DIRECTOR_PORT}`
const CELL = `http://127.0.0.1:${CELL_PORT}`
const ISSUER = `http://127.0.0.1:${JWKS_PORT}`
const CELL_ID = 'rt-c1'
const USER = `rt-user-${randomBytes(3).toString('hex')}`
const ASSIGNMENT_KEY = randomBytes(36).toString('base64url')
const CELL_STARTED_AT = Date.now()
const CELL_INCARNATION = crypto.randomUUID()

const results: { name: string; ok: boolean }[] = []
function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (s: string) => createHash('sha256').update(s).digest('base64url')
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end && !cond()) await sleep(25)
  return cond()
}

const box = nacl.box.keyPair()
const host = {
  relayHostId: createHash('sha256').update(box.publicKey).digest('base64url').slice(0, 16),
  keypair: { publicKey: box.publicKey, secretKey: box.secretKey, publicKeyB64: Buffer.from(box.publicKey).toString('base64') }
}

let userKey: KeyLike
let adminKey: KeyLike
async function mint(): Promise<string> {
  return new SignJWT({ purpose: 'host-control', prof: `prof-${USER}`, relayHostId: host.relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: 'spike' })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(userKey)
}

async function heartbeat(): Promise<void> {
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
      if (!r.ok) console.log(`heartbeat ${r.status} ${await r.text()}`)
    })
    .catch((e: Error) => console.log(`heartbeat error ${e.message}`))
}

const children: ChildProcess[] = []
function relay(role: 'director' | 'cell', extra: Record<string, string> = {}): { child: ChildProcess; log: string[] } {
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
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (d) => log.push(String(d)))
  children.push(child)
  return { child, log }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGKILL')
  await new Promise((r) => child.once('exit', r))
}

async function ready(url: string, log: string[], marker?: string): Promise<void> {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const up = await fetch(`${url}/health`).then((r) => r.ok, () => false)
    if (up && (!marker || log.join('').includes(marker))) return
    await sleep(200)
  }
  throw new Error(`not ready: ${url}\n${log.join('').slice(-2000)}`)
}

async function director(cohort: { allow?: boolean; deny?: boolean }) {
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

async function assign(): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${DIRECTOR}/v1/assign`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await mint()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, relayHostId: host.relayHostId, preferredRegion: 'us-central1' })
  })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }
}

function control(cellUrl: string, epoch: number, jwt: string) {
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

async function online(cellUrl: string, epoch: number) {
  const c = control(cellUrl, epoch, await mint())
  const ack = await c.client.connect()
  c.attach(ack.generation)
  return c
}

async function phone(cellUrl: string, credential: string) {
  const ws = new WebSocket(`${cellUrl.replace(/^http/, 'ws')}/v1/connect/${host.relayHostId}`, { perMessageDeflate: false })
  const state = { hello: null as Record<string, unknown> | null, closed: null as number | null }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential })))
  ws.on('message', (raw) => {
    if (state.hello === null) state.hello = JSON.parse(raw.toString())
  })
  ws.on('close', (code) => (state.closed = code))
  ws.on('error', () => {})
  await waitFor(() => state.hello !== null || state.closed !== null, 8000)
  return { ws, state }
}

// Pairs a new phone through an invite and installs its resume token; returns the token.
async function pair(c: Awaited<ReturnType<typeof online>>, cellUrl: string, deviceId: string): Promise<string> {
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

const resumed = (p: Awaited<ReturnType<typeof phone>>) =>
  RelayPhoneHelloSchema.safeParse(p.state.hello).success && p.state.hello?.credentialKind === 'resume'

async function closeControl(c: Awaited<ReturnType<typeof online>>): Promise<void> {
  c.client.closeNow()
  await sleep(1500)
}

async function main(): Promise<void> {
  const keys = await loadOrCreateKeys()
  userKey = (await importJWK(keys.privateJwk, 'ES256')) as KeyLike
  const admin = await generateKeyPair('RS256', { extractable: true })
  adminKey = admin.privateKey
  const adminJwk = { ...(await exportJWK(admin.publicKey)), kid: 'admin-key', alg: 'RS256', use: 'sig' }
  const jwks = createServer((_q, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [{ ...keys.publicJwk, kid: 'spike', alg: 'ES256', use: 'sig' }, adminJwk] }))
  })
  await new Promise<void>((r) => jwks.listen(JWKS_PORT, '127.0.0.1', () => r()))
  const db = new pg.Client({ connectionString: DATABASE_URL })
  const beat = setInterval(() => void heartbeat(), 5_000)
  try {
    const cell = relay('cell')
    let d = await director({})
    await ready(CELL, cell.log)
    await db.connect()

    // 1. On the GCE cell: pair phone A.
    const first = await assign()
    const e1 = Number(first.body.assignmentEpoch)
    if (first.status !== 200) console.log(JSON.stringify(first.body), d.log.join('').slice(-3000))
    record('1 director places the host on the cell', first.status === 200 && first.body.cellUrl === CELL, JSON.stringify({ status: first.status, cellUrl: first.body.cellUrl, epoch: e1 }))
    const onCell = await online(CELL, e1)
    const tokenA = await pair(onCell, CELL, 'phone-a')
    record('1 phone A resumes on the cell', resumed(await phone(CELL, tokenA)))
    await closeControl(onCell)

    // 2. Cohort on: the director pushes the host and phone A to the edge.
    await stop(d.child)
    d = await director({ allow: true })
    // A host still holding a unit on its old cell (the pairing invite) stays there, never a 503.
    let toEdge = await assign()
    const firstAsk = toEdge
    const askStarted = Date.now()
    while (toEdge.status === 200 && toEdge.body.cellUrl === CELL && Date.now() - askStarted < 720_000) {
      await sleep(20_000)
      toEdge = await assign()
    }
    record('2 while old-cell units settle the host stays on the cell (200, not 503)', firstAsk.status === 200, JSON.stringify({ status: firstAsk.status, cellUrl: firstAsk.body.cellUrl, movedAfterS: Math.round((Date.now() - askStarted) / 1000) }))
    const e2 = Number(toEdge.body.assignmentEpoch)
    record('2 director answers the edge with a newer epoch', toEdge.status === 200 && toEdge.body.cellUrl === EDGE_URL && e2 > e1, JSON.stringify({ status: toEdge.status, cellUrl: toEdge.body.cellUrl, epoch: e2, body: toEdge.status === 200 ? undefined : toEdge.body }))
    const onEdge = await online(EDGE_URL, e2)
    record('2 desktop hello accepted on the edge at that epoch', true)
    record('2 phone A (paired on the cell) resumes on the edge', resumed(await phone(EDGE_URL, tokenA)))
    const oldCell = await phone(CELL, tokenA)
    await waitFor(() => oldCell.state.closed !== null, 4000)
    record('2 the old cell tells phone A WRONG_CELL (4409)', oldCell.state.closed === 4409 || oldCell.state.hello?.code === 4409, `close=${oldCell.state.closed} hello=${JSON.stringify(oldCell.state.hello)}`)

    // 3. On the edge: pair phone B, revoke phone A.
    const tokenB = await pair(onEdge, EDGE_URL, 'phone-b')
    await onEdge.client.revokeDevice('phone-a')
    record('3 phone B resumes on the edge', resumed(await phone(EDGE_URL, tokenB)))

    // 4. Cohort off while the desktop is still on the edge: retry, nothing moves.
    await stop(d.child)
    d = await director({ deny: true })
    const busy = await assign()
    record('4 leaving while the desktop is connected to the edge: 503 Retry-After', busy.status === 503, `status=${busy.status}`)
    await closeControl(onEdge)

    // 5. Move back: export, Postgres devices replaced, placed on the cell, edge fenced.
    const back = await assign()
    const e3 = Number(back.body.assignmentEpoch)
    record('5 director places the host back on the cell with a newer epoch', back.status === 200 && back.body.cellUrl === CELL && e3 > e2, JSON.stringify({ status: back.status, cellUrl: back.body.cellUrl, epoch: e3, body: back.status === 200 ? undefined : back.body }))
    const rows = (
      await db.query(`SELECT relay_device_id, revoked_at FROM relay_devices WHERE relay_host_id = $1 ORDER BY relay_device_id`, [host.relayHostId])
    ).rows.map((r) => `${r.relay_device_id}:${r.revoked_at === null ? 'live' : 'revoked'}`)
    record('5 Postgres has the edge-side changes (A revoked, B paired)', rows.join(',') === 'phone-a:revoked,phone-b:live', rows.join(','))
    const fenced = await phone(EDGE_URL, tokenB)
    await waitFor(() => fenced.state.closed !== null, 4000)
    record('5 the edge tells phones WRONG_CELL (4409) after the move', fenced.state.closed === 4409, `close=${fenced.state.closed}`)
    const backOnCell = await online(CELL, e3)
    record('5 phone B (paired on the edge) resumes on the cell', resumed(await phone(CELL, tokenB)))
    const revoked = await phone(CELL, tokenA)
    await waitFor(() => revoked.state.closed !== null, 4000)
    // A cell's database path answers any credential it cannot place with WRONG_CELL (today's
    // behaviour); the phone then re-resolves, and the director must refuse the revoked token.
    // B first: a failed resolve rate-limits the host's next one (today's director rule).
    const resolveB = await fetch(`${DIRECTOR}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: host.relayHostId, resumeToken: tokenB })
    })
    const resolveA = await fetch(`${DIRECTOR}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: host.relayHostId, resumeToken: tokenA })
    })
    record(
      '5 phone A (revoked on the edge) is not admitted on the cell, and the director will not resolve it',
      !resumed(revoked) && revoked.state.closed !== null && resolveA.status !== 200 && resolveB.status === 200,
      `close=${revoked.state.closed} resolveA=${resolveA.status} resolveB=${resolveB.status}`
    )
    await closeControl(backOnCell)
  } finally {
    clearInterval(beat)
    await db.end().catch(() => undefined)
    for (const child of children) await stop(child)
    jwks.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
  for (const child of children) child.kill('SIGKILL')
  process.exit(1)
})
