// Phase 2 checks: the edge on the object backend (credential store on each HostRelay's own SQLite,
// assignments pushed by the director over signed admin calls). No Postgres. Drives the SHIPPED
// desktop control client and the shipped phone hello parser in local workerd.
//   npx tsx test/mvp-object.ts
// Against a deployed phase-2 Worker (test JWKS = spike/.keys.json, test signing key from a file):
//   MVP_URL=https://<worker> MVP_KEY_FILE=<path> MVP_ISSUER=<ADMIN_ISSUER> npx tsx test/mvp-object.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair, importJWK, type KeyLike } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/relay-transport'
import { RelayPhoneHelloSchema } from '../../../../src/shared/remote-runtime/relay/mobile-relay-phone-protocol'

const PORT = 8789
const REMOTE = process.env.MVP_URL?.replace(/\/$/, '')
const ORIGIN = REMOTE ?? `http://127.0.0.1:${PORT}`
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws')
const SIGNING_KEY = process.env.MVP_KEY_FILE ? readFileSync(process.env.MVP_KEY_FILE, 'utf8').trim() : randomBytes(36).toString('base64url')
const DIRECTOR = process.env.MVP_ISSUER ?? 'https://director.test.invalid'
const ERASE_KEY = randomBytes(36).toString('base64url')
const ERASER = 'https://api.erasure.test.invalid'
const ISSUER = 'https://auth.test.invalid'
const EPOCH = 7
const USER = 'user-mvp'

const results: { name: string; ok: boolean; detail: string }[] = []
function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha = (s: string) => createHash('sha256').update(s).digest('base64url')
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(25)
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

async function mint(key: KeyLike, relayHostId: string, issuer = ISSUER): Promise<string> {
  return new SignJWT({ purpose: 'host-control', prof: `prof-${USER}`, relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: REMOTE ? 'spike' : 'mvp' })
    .setSubject(USER)
    .setIssuer(issuer)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

function control(host: Host, jwt: string, epoch = EPOCH) {
  const events = { closes: [] as number[], opens: [] as { connId: string }[] }
  let transport: CloudRelayTransport | null = null
  const client = new RelayControlClient({
    cellUrl: ORIGIN,
    relayJwt: jwt,
    relayHostId: host.relayHostId,
    assignmentEpoch: epoch,
    identity: { userId: USER, profileId: `prof-${USER}`, organizationId: '' },
    keypair: host.keypair as never,
    appVersion: 'mvp',
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
      transport = new CloudRelayTransport({ cellUrl: ORIGIN, relayHostId: host.relayHostId, generation })
      transport.onMessage(((m: string | Uint8Array, reply: (r: string | Uint8Array) => void) => reply(m)) as never)
      return transport
    }
  }
}

function phone(relayHostId: string, credential: string) {
  const ws = new WebSocket(`${WS_ORIGIN}/v1/connect/${relayHostId}`, { perMessageDeflate: false })
  const state = { hello: null as Record<string, unknown> | null, closed: null as number | null, reason: '' }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential })))
  ws.on('message', (raw) => {
    if (state.hello === null) state.hello = JSON.parse(raw.toString())
  })
  ws.on('close', (code, reason) => {
    state.closed = code
    state.reason = reason.toString()
  })
  ws.on('error', () => {})
  return { ws, state }
}

async function phoneOutcome(relayHostId: string, credential: string) {
  const p = phone(relayHostId, credential)
  await waitFor(() => p.state.hello !== null || p.state.closed !== null, 8000)
  return p
}


// ---- director side: the signed admin calls (as the director will make them) ----
async function adminCall(op: string, body: unknown, opts: { key?: string; issuer?: string; tokenOp?: string; tokenBody?: string } = {}) {
  const raw = JSON.stringify(body)
  const token = await new SignJWT({ purpose: 'edge-admin', op: opts.tokenOp ?? op, bodySha256: sha(opts.tokenBody ?? raw) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.issuer ?? DIRECTOR)
    .setAudience('orca-relay-edge-admin')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(opts.key ?? SIGNING_KEY))
  const r = await fetch(`${ORIGIN}/__admin/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: raw })
  const text = await r.text()
  return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null }
}
const assign = (relayHostId: string, cellId: string, assignmentEpoch: number, devices?: unknown[]) =>
  adminCall('assign', { userId: USER, relayHostId, cellId, assignmentEpoch, ...(devices ? { devices } : {}) })

async function mainRemote(): Promise<void> {
  // Deployed Worker: inline test JWKS (spike keys), no issuer check, no local dev server.
  const keys = JSON.parse(readFileSync(new URL('../spike/.keys.json', import.meta.url), 'utf8'))
  const privateKey = (await importJWK(keys.privateJwk, 'ES256')) as KeyLike
  await run(newHost(), privateKey, () => 1, true)
  const stray = await phoneOutcome(newHost().relayHostId, b64url(randomBytes(32)))
  await waitFor(() => stray.state.closed !== null, 3000)
  record('E11 phone for an unpushed host: relay-hello{ok:false,4409}, close 4409', stray.state.hello?.code === 4409 && stray.state.closed === 4409, `close=${stray.state.closed}`)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed (${ORIGIN})`)
  if (failed.length) process.exitCode = 1
}

async function main(): Promise<void> {
  if (REMOTE) return mainRemote()
  const host = newHost()
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'mvp', alg: 'ES256', use: 'sig' }
  let jwksHits = 0
  const jwks = createServer((_req, res) => {
    jwksHits++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', () => r()))
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks`
  writeFileSync(
    new URL('../.dev.vars', import.meta.url),
    [
      'EDGE_BACKEND=object',
      `ADMIN_SIGNING_KEY=${SIGNING_KEY}`,
      `ERASE_SIGNING_KEY=${ERASE_KEY}`,
      `ERASE_ISSUER=${ERASER}`,
      `ADMIN_ISSUER=${DIRECTOR}`,
      `RELAY_JWKS_URL=${jwksUrl}`,
      `RELAY_AUTH_ISSUER=${ISSUER}`,
      'PING_INTERVAL_MS=3000',
      'SILENCE_TIMEOUT_MS=9000',
      'ORPHAN_GRACE_MS=4000',
      // The daily sweep every 3 s (it then runs under the whole flow), wiping hosts gone 6 s.
      'SWEEP_INTERVAL_MS=3000',
      'LEFT_RETENTION_MS=6000'
    ].join('\n')
  )
  const stateDir = mkdtempSync(join(tmpdir(), 'relay-edge-mvp-object-'))
  const dev: ChildProcess = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', stateDir],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let devLog = ''
  dev.stdout?.on('data', (d) => (devLog += d))
  dev.stderr?.on('data', (d) => (devLog += d))
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${ORIGIN}/health`)).ok) break
      } catch {}
      if (i > 120) throw new Error(`wrangler dev did not start:\n${devLog}`)
      await sleep(500)
    }
    await run(host, privateKey, () => jwksHits)
    await sweepCheck()
    await preAuthCheck(stateDir)
  } catch (error) {
    console.error(error)
    console.error(devLog.split('\n').filter((l) => /error|exception/i.test(l)).slice(-20).join('\n'))
    process.exitCode = 1
  } finally {
    dev.kill('SIGINT')
    jwks.close()
    await sleep(500)
    rmSync(stateDir, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

async function run(host: Host, key: KeyLike, jwksHits: () => number, remote = false): Promise<void> {
  const jwt = await mint(key, host.relayHostId)
  const id = host.relayHostId

  // P2: admin calls are authenticated, bound to their body and op, and epochs only move forward.
  {
    const body = { userId: USER, relayHostId: id, cellId: 'edge', assignmentEpoch: EPOCH, devices: [] }
    const wrongKey = await adminCall('assign', body, { key: randomBytes(36).toString('base64url') })
    const otherBody = await adminCall('assign', body, { tokenBody: JSON.stringify({ ...body, assignmentEpoch: 99 }) })
    const otherOp = await adminCall('assign', body, { tokenOp: 'erase' })
    record('P2 forged key, other body, other op: all 401', wrongKey.status === 401 && otherBody.status === 401 && otherOp.status === 401, `${wrongKey.status}/${otherBody.status}/${otherOp.status}`)
    const before = control(host, jwt)
    const r = await before.client.connect().catch((e: Error) => e)
    await waitFor(() => before.events.closes.length > 0, 3000)
    record('P2 no pushed assignment: hello closes 4409 (desktop re-asks the director)', r instanceof Error && before.events.closes.includes(4409), `closes=${before.events.closes}`)
    const ok = await adminCall('assign', body)
    const again = await adminCall('assign', body)
    const stale = await assign(id, 'edge', EPOCH - 1)
    const conflict = await assign(id, 'c10', EPOCH)
    record('P2 push applied; retry unchanged; older epoch 409 stale; same epoch other cell 409', ok.json?.outcome === 'applied' && again.json?.outcome === 'unchanged' && stale.status === 409 && stale.json?.outcome === 'stale' && conflict.status === 409, `${ok.json?.outcome}/${again.json?.outcome}/${stale.status}:${stale.json?.outcome}/${conflict.status}`)
  }

  // E1: fetched JWKS + issuer; wrong issuer is 401 before the upgrade (local only: the deployed
  // test Worker uses an inline JWKS without an issuer).
  if (!remote) {
    const bad = new WebSocket(`${WS_ORIGIN}/v1/host/control`, {
      headers: { authorization: `Bearer ${await mint(key, id, 'https://evil.invalid')}` }
    })
    const status = await new Promise<number>((res) => bad.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)))
    record('E1 JWKS fetched from URL; wrong issuer refused 401', status === 401 && jwksHits() >= 1, `status=${status} jwksFetches=${jwksHits()}`)
  }
  // E12: frames over the cells' limits close 1009 (control 1 MiB; splices 8 MiB).
  {
    const big = new WebSocket(`${WS_ORIGIN}/v1/host/control`, { headers: { authorization: `Bearer ${jwt}` }, perMessageDeflate: false })
    big.on('error', () => {})
    const code = await new Promise<number>((res) => {
      big.on('open', () => big.send('x'.repeat(1024 * 1024 + 1)))
      big.on('close', (c) => res(c))
      setTimeout(() => res(-1), 8000)
    })
    record('E12 control frame over 1 MiB closes 1009', code === 1009, `close=${code}`)
  }
  {
    const wrong = control(host, jwt, EPOCH - 1)
    const r = await wrong.client.connect().catch((e: Error) => e)
    await waitFor(() => wrong.events.closes.length > 0, 3000)
    record('E1 hello at a stale epoch closes 4409', r instanceof Error && wrong.events.closes.includes(4409), `closes=${wrong.events.closes}`)
  }
  const main = control(host, jwt)
  const ack = await main.client.connect()
  main.attach(ack.generation)
  record('E1 hello at the pushed epoch is accepted (shipped client)', ack.generation >= 1, `generation=${ack.generation}`)

  // E2 on object storage: invite, install, resume, confirm (shipped strict parsers).
  const invite = await main.client.createInvite('device-a').catch((e: Error) => e)
  record('E2 invite-create returns a strict invite-created', !(invite instanceof Error) && typeof invite.inviteToken === 'string', invite instanceof Error ? invite.message : `max=${invite.maxAttempts}`)
  if (invite instanceof Error) return
  const invitePhone = await phoneOutcome(id, invite.inviteToken)
  const inviteConnId = main.events.opens.at(-1)?.connId ?? ''
  record('E2 invite phone admitted, relay-hello(invite) strict-parses', RelayPhoneHelloSchema.safeParse(invitePhone.state.hello).success && invitePhone.state.hello?.credentialKind === 'invite', JSON.stringify(invitePhone.state.hello))
  const resumeToken = b64url(randomBytes(32))
  const install = { reqId: 'install-1', relayDeviceId: 'device-a', newResumeTokenHash: sha(resumeToken), authorization: { mode: 'relay-basis' as const, basisConnId: inviteConnId } }
  const first = await main.client.installCredential(install).catch((e: Error) => e)
  const again = await main.client.installCredential(install).catch((e: Error) => e)
  const status = await main.client.credentialInstallStatus('device-a', 'install-1').catch((e: Error) => e)
  record('E2 install on relay basis; idempotent; status committed', !(first instanceof Error) && JSON.stringify(first) === JSON.stringify(again) && !(status instanceof Error) && status.state === 'committed', first instanceof Error ? first.message : `version=${first.currentVersion}`)
  invitePhone.ws.close()
  const resumePhone = await phoneOutcome(id, resumeToken)
  const resumeConnId = main.events.opens.at(-1)?.connId ?? ''
  record('E2 resume phone admitted, relay-hello(resume) strict-parses', RelayPhoneHelloSchema.safeParse(resumePhone.state.hello).success && resumePhone.state.hello?.credentialKind === 'resume', JSON.stringify(resumePhone.state.hello))
  const c1 = await main.client.confirmResume(resumeConnId, 'confirm-1').catch((e: Error) => e)
  const c2 = await main.client.confirmResume(resumeConnId, 'confirm-1').catch((e: Error) => e)
  record('E2 resume-confirm commits; same reqId returns the stored result', !(c1 instanceof Error) && JSON.stringify(c1) === JSON.stringify(c2), c1 instanceof Error ? c1.message : `acceptedAs=${c1.acceptedAs}`)
  const unknown = await phoneOutcome(id, b64url(randomBytes(32)))
  await waitFor(() => unknown.state.closed !== null, 2000)
  record('E2 unknown credential: relay-hello{ok:false,4401} and close 4401', unknown.state.hello?.code === 4401 && unknown.state.closed === 4401, `close=${unknown.state.closed}`)

  // P3: credentials survive a move away and back. The director exports (refused while the desktop
  // is connected; freezes the host), writes Postgres, places the host, then fences the edge.
  const leftover = await main.client.createInvite('device-b').catch((e: Error) => e)
  const busyExport = await adminCall('export', { relayHostId: id })
  record('P3 export refused 409 busy while the desktop is connected', busyExport.status === 409 && busyExport.json?.outcome === 'busy', `${busyExport.status}:${busyExport.json?.outcome}`)
  main.client.closeNow()
  await sleep(800)
  const exported = await adminCall('export', { relayHostId: id })
  const devices = (exported.json?.devices ?? []) as { relay_device_id: string; current_hash: string }[]
  record('P3 export returns the installed device', exported.json?.outcome === 'exported' && devices.length === 1 && devices[0].relay_device_id === 'device-a' && devices[0].current_hash === sha(resumeToken), JSON.stringify(devices.map((d) => d.relay_device_id)))
  const frozenHello = control(host, jwt)
  const fh = await frozenHello.client.connect().catch((e: Error) => e)
  await waitFor(() => frozenHello.events.closes.length > 0, 3000)
  const frozenPhone = await phoneOutcome(id, resumeToken)
  await waitFor(() => frozenPhone.state.closed !== null, 2000)
  record('P3 while frozen: hello 4409, phone 4409 (nothing changes after the snapshot)', fh instanceof Error && frozenHello.events.closes.includes(4409) && frozenPhone.state.closed === 4409, `hello=${frozenHello.events.closes} phone=${frozenPhone.state.closed}`)
  const away = await assign(id, 'c10', EPOCH + 1)
  const movedPhone = await phoneOutcome(id, resumeToken)
  await waitFor(() => movedPhone.state.closed !== null, 2000)
  record('P3 fence to another cell applied; phone 4409', away.json?.outcome === 'applied' && movedPhone.state.closed === 4409, `${away.json?.outcome} phone=${movedPhone.state.closed}`)
  const behind = await assign(id, 'edge', EPOCH)
  record('P3 a push below the edge epoch is 409 stale and names the edge epoch', behind.status === 409 && behind.json?.outcome === 'stale' && behind.json?.assignmentEpoch === EPOCH + 1, JSON.stringify(behind.json))
  const backPush = await assign(id, 'edge', EPOCH + 2, devices)
  const back = control(host, jwt, EPOCH + 2)
  const ack2 = await back.client.connect()
  back.attach(ack2.generation)
  const returned = await phoneOutcome(id, resumeToken)
  record('P3 move back with the exported devices: hello ok, same resume token admitted', backPush.json?.outcome === 'applied' && returned.state.hello?.credentialKind === 'resume', JSON.stringify(returned.state.hello))
  returned.ws.close()
  if (!(leftover instanceof Error)) {
    const stalePhone = await phoneOutcome(id, leftover.inviteToken)
    await waitFor(() => stalePhone.state.closed !== null, 2000)
    record('P3 an invite from the earlier stay is void after the move back (4401)', stalePhone.state.closed === 4401, `close=${stalePhone.state.closed}`)
  }

  // E2: revoke; the revoked token is refused.
  const revoked = await back.client.revokeDevice('device-a').then(() => 'ok').catch((e: Error) => e.message)
  const afterRevoke = await phoneOutcome(id, resumeToken)
  await waitFor(() => afterRevoke.state.closed !== null, 2000)
  record('E2 revoke, then the revoked token is refused 4401', revoked === 'ok' && afterRevoke.state.closed === 4401, `revoke=${revoked} close=${afterRevoke.state.closed}`)

  // P4: erasure refused while live; then everything goes.
  const busy = await adminCall('erase', { userId: USER, relayHostId: id })
  const otherUser = await adminCall('erase', { userId: 'someone-else', relayHostId: id })
  back.client.closeNow()
  await sleep(800)
  // Local: the erasure job's own key erases; it cannot push (the deployed env has no erase key).
  const eraser = remote ? {} : { key: ERASE_KEY, issuer: ERASER }
  if (!remote) {
    const pushAsEraser = await adminCall('assign', { userId: USER, relayHostId: id, cellId: 'edge', assignmentEpoch: 99 }, eraser)
    record('P4 the erasure key cannot push assignments (401)', pushAsEraser.status === 401, `${pushAsEraser.status}`)
  }
  const erased = await adminCall('erase', { userId: USER, relayHostId: id }, eraser)
  const afterErase = await adminCall('export', { relayHostId: id })
  const ghost = control(host, jwt, EPOCH + 2)
  const g = await ghost.client.connect().catch((e: Error) => e)
  await waitFor(() => ghost.events.closes.length > 0, 3000)
  record(
    'P4 erase: busy while live, mismatch for another user, then erased; no data left; hello 4409',
    busy.json?.outcome === 'busy' && otherUser.json?.outcome === 'mismatch' && erased.json?.outcome === 'erased' && afterErase.json?.assignment === null && (afterErase.json?.devices as unknown[]).length === 0 && g instanceof Error && ghost.events.closes.includes(4409),
    `${busy.json?.outcome}/${otherUser.json?.outcome}/${erased.json?.outcome} left=${JSON.stringify(afterErase.json)} hello=${ghost.events.closes}`
  )
}

// E10 (local only: short sweep and retention): a host that moved away is wiped by its sweep.
async function sweepCheck(): Promise<void> {
  const id = newHost().relayHostId
  const away = await assign(id, 'c10', 5)
  await sleep(11_000)
  const after = await assign(id, 'edge', 1)
  record('E10 sweep wipes an object whose host left past the retention (older epoch now applies)', away.json?.outcome === 'applied' && after.json?.outcome === 'applied', `${away.json?.outcome}/${after.json?.outcome}`)
}

// E11 (local only): a phone for a host nobody pushed is sent to the director without any object
// storage; unauthenticated upgrades are limited per source (local limit 60/min).
async function preAuthCheck(stateDir: string): Promise<void> {
  const list = () => readdirSync(stateDir, { recursive: true }).map(String).filter((f) => f.endsWith('.sqlite'))
  const files = () => list().length
  const beforeList = new Set(list())
  const before = files()
  const stray = await phoneOutcome(newHost().relayHostId, b64url(randomBytes(32)))
  await waitFor(() => stray.state.closed !== null, 3000)
  await sleep(500)
  // Local dev opens a file (with its own __miniflare table) for any object it starts; what counts
  // is that the edge wrote nothing to it.
  const created = list().filter((f) => !beforeList.has(f))
  const tables = created.flatMap((f) => {
    const db = new DatabaseSync(join(stateDir, f), { readOnly: true })
    try {
      // Any table at all (KV puts land in _cf_KV), or any row in one, is a write.
      return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__miniflare%'").all().map((r) => String(r.name))
        .map((name) => `${name}:${Number((db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n)}`)
    } finally {
      db.close()
    }
  })
  record(
    'E11 phone for an unpushed host: relay-hello{ok:false,4409}, close 4409, nothing written to object storage',
    stray.state.hello?.code === 4409 && stray.state.closed === 4409 && tables.length === 0,
    `hello=${JSON.stringify(stray.state.hello)} close=${stray.state.closed} newFiles=${created.length} tables=${tables.join(',') || 'none'}`
  )
  const id = newHost().relayHostId
  const statuses: number[] = []
  for (let i = 0; i < 70; i++) statuses.push((await fetch(`${ORIGIN}/v1/connect/${id}`)).status)
  const data = (await fetch(`${ORIGIN}/v1/host/data/x`)).status
  record(
    'E11 unauthenticated phone upgrades past the per-source limit get 429; data sockets count apart',
    statuses.includes(426) && statuses.at(-1) === 429 && data === 426,
    `first=${statuses[0]} last=${statuses.at(-1)} limitedFrom=${statuses.indexOf(429)} data=${data}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
