// MVP checks for the edge on its real backend: the cells' credential store over (local) Hyperdrive,
// a fetched JWKS with issuer check, and the director's assignment row. Drives the SHIPPED desktop
// control client (commands and their strict response parsers) and the shipped phone hello parser.
//
// Needs a local Postgres with the relay schema (see test/apply-schema.ts) at the URL in
// wrangler.jsonc's localConnectionString, and its data directory for the database-down check:
//   MVP_PGDATA=/tmp/relay-edge-mvp-pg npx tsx test/mvp.ts
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose'
import nacl from 'tweetnacl'
import pg from 'pg'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/transports/relay-transport'
import { RelayPhoneHelloSchema } from '../../../../src/shared/remote-runtime/relay/mobile-relay-phone-protocol'

const PORT = 8788
const ORIGIN = `http://127.0.0.1:${PORT}`
const DB_URL = process.env.MVP_DB_URL ?? 'postgres://relay:local-test@127.0.0.1:55433/relay'
const PGDATA = process.env.MVP_PGDATA ?? '/tmp/relay-edge-mvp-pg'
const PGPORT = new URL(DB_URL).port
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
    if (cond()) { return true }
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
    .setProtectedHeader({ alg: 'ES256', kid: 'mvp' })
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
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/connect/${relayHostId}`, { perMessageDeflate: false })
  const state = { hello: null as Record<string, unknown> | null, closed: null as number | null, reason: '' }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential })))
  ws.on('message', (raw) => {
    if (state.hello === null) { state.hello = JSON.parse(raw.toString()) }
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

async function main(): Promise<void> {
  const db = new pg.Client({ connectionString: DB_URL })
  // The database-down check stops Postgres under this client.
  db.on('error', () => {})
  await db.connect()
  for (const table of [
    'relay_assignments', 'relay_devices', 'relay_invites', 'relay_connection_bases', 'relay_confirm_results',
    'relay_install_results', 'relay_audit_events', 'relay_rate_windows', 'relay_direct_authorizations'
  ]) {
    await db.query(`DELETE FROM ${table}`)
  }
  const host = newHost()
  const now = Date.now()
  const seat = (cellId: string) =>
    db.query(
      `INSERT INTO relay_assignments (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
         reserved_controls, reserved_splices, reserved_invites, pending_installs, pending_confirmations, migration_leases)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 0, 0)
       ON CONFLICT (user_id, relay_host_id) DO UPDATE SET cell_id = EXCLUDED.cell_id`,
      [USER, host.relayHostId, cellId, EPOCH, now + 3_600_000, now]
    )
  await seat('edge')

  // ---- JWKS served over HTTP, as the auth service does ----
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
      'EDGE_BACKEND=postgres',
      `RELAY_JWKS_URL=${jwksUrl}`,
      `RELAY_AUTH_ISSUER=${ISSUER}`,
      'PING_INTERVAL_MS=3000',
      'SILENCE_TIMEOUT_MS=9000',
      'ORPHAN_GRACE_MS=4000'
    ].join('\n')
  )
  const stateDir = mkdtempSync(join(tmpdir(), 'relay-edge-mvp-'))
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
        if ((await fetch(`${ORIGIN}/health`)).ok) { break }
      } catch {}
      if (i > 120) { throw new Error(`wrangler dev did not start:\n${devLog}`) }
      await sleep(500)
    }
    await run(host, privateKey, seat, () => jwksHits)
  } finally {
    // Never leave the database stopped.
    try {
      execSync(`pg_ctl -D ${PGDATA} status`, { stdio: 'ignore' })
    } catch {
      execSync(`pg_ctl -D ${PGDATA} -o "-p ${PGPORT} -k /tmp" -l ${PGDATA}.log start`, { stdio: 'ignore' })
    }
    dev.kill('SIGINT')
    jwks.close()
    await db.end().catch(() => {})
    await sleep(500)
    rmSync(stateDir, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) { process.exitCode = 1 }
}

async function run(
  host: Host,
  key: KeyLike,
  seat: (cellId: string) => Promise<unknown>,
  jwksHits: () => number
): Promise<void> {
  const jwt = await mint(key, host.relayHostId)

  // E1: fetched JWKS + issuer; wrong issuer is 401 before the upgrade.
  {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/v1/host/control`, {
      headers: { authorization: `Bearer ${await mint(key, host.relayHostId, 'https://evil.invalid')}` }
    })
    const status = await new Promise<number>((res) => bad.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)))
    record('E1 JWKS fetched from URL; wrong issuer refused 401', status === 401 && jwksHits() >= 1, `status=${status} jwksFetches=${jwksHits()}`)
  }

  // E1: assignment epoch check against the director's row.
  {
    const wrong = control(host, jwt, EPOCH - 1)
    const r = await wrong.client.connect().catch((e: Error) => e)
    await waitFor(() => wrong.events.closes.length > 0, 3000)
    record('E1 hello at a stale epoch closes 4409 (wrong assignment epoch)', r instanceof Error && wrong.events.closes.includes(4409), `closes=${wrong.events.closes}`)
  }

  const main = control(host, jwt)
  const ack = await main.client.connect()
  main.attach(ack.generation)
  record('E1 hello at the assigned epoch is accepted (shipped client)', ack.generation >= 1, `generation=${ack.generation}`)

  // E2: invite-create through the shipped client's strict parser.
  const invite = await main.client.createInvite('device-a').catch((e: Error) => e)
  record('E2 invite-create returns a strict invite-created', !(invite instanceof Error) && typeof invite.inviteToken === 'string', invite instanceof Error ? invite.message : `expiresIn=${Math.round((invite.expiresAt - Date.now()) / 1000)}s max=${invite.maxAttempts}`)
  if (invite instanceof Error) { return }

  // E2: phone connects with the invite; shipped phone parser accepts relay-hello(invite).
  const invitePhone = await phoneOutcome(host.relayHostId, invite.inviteToken)
  const inviteHello = RelayPhoneHelloSchema.safeParse(invitePhone.state.hello)
  const inviteConnId = main.events.opens.at(-1)?.connId ?? ''
  record('E2 invite phone admitted, relay-hello(invite) strict-parses', inviteHello.success && invitePhone.state.hello?.ok === true && invitePhone.state.hello?.credentialKind === 'invite', JSON.stringify(invitePhone.state.hello))

  // E2: install a resume credential on the invite's basis; repeat is idempotent; status committed.
  const resumeToken = b64url(randomBytes(32))
  const install = { reqId: 'install-1', relayDeviceId: 'device-a', newResumeTokenHash: sha(resumeToken), authorization: { mode: 'relay-basis' as const, basisConnId: inviteConnId } }
  const first = await main.client.installCredential(install).catch((e: Error) => e)
  const again = await main.client.installCredential(install).catch((e: Error) => e)
  const status = await main.client.credentialInstallStatus('device-a', 'install-1').catch((e: Error) => e)
  record(
    'E2 device-credential-install on relay basis; same reqId idempotent; status committed',
    !(first instanceof Error) && !(again instanceof Error) && JSON.stringify(first) === JSON.stringify(again) && !(status instanceof Error) && status.state === 'committed',
    first instanceof Error ? first.message : again instanceof Error ? again.message : `version=${first.currentVersion} status=${status instanceof Error ? status.message : status.state}`
  )
  invitePhone.ws.close()

  // E2: resume phone; confirm; repeat confirm idempotent.
  const resumePhone = await phoneOutcome(host.relayHostId, resumeToken)
  const resumeHello = RelayPhoneHelloSchema.safeParse(resumePhone.state.hello)
  const resumeConnId = main.events.opens.at(-1)?.connId ?? ''
  record('E2 resume phone admitted, relay-hello(resume) strict-parses', resumeHello.success && resumePhone.state.hello?.credentialKind === 'resume', JSON.stringify(resumePhone.state.hello))
  const c1 = await main.client.confirmResume(resumeConnId, 'confirm-1').catch((e: Error) => e)
  const c2 = await main.client.confirmResume(resumeConnId, 'confirm-1').catch((e: Error) => e)
  record('E2 device-resume-confirm commits; same reqId returns the stored result', !(c1 instanceof Error) && !(c2 instanceof Error) && JSON.stringify(c1) === JSON.stringify(c2), c1 instanceof Error ? c1.message : c2 instanceof Error ? c2.message : `acceptedAs=${c1.acceptedAs} renewed=${c1.renewed}`)
  resumePhone.ws.close()

  // E2: a token the database doesn't know is 4401 (strict relay-hello ok:false).
  const unknown = await phoneOutcome(host.relayHostId, b64url(randomBytes(32)))
  await waitFor(() => unknown.state.closed !== null, 2000)
  record('E2 unknown credential: relay-hello{ok:false,4401} and close 4401', unknown.state.hello?.ok === false && unknown.state.hello?.code === 4401 && unknown.state.closed === 4401 && RelayPhoneHelloSchema.safeParse(unknown.state.hello).success, `hello=${JSON.stringify(unknown.state.hello)} close=${unknown.state.closed}`)

  // E2: host offline. Assignment names the edge -> 4404; names another cell -> 4409 (phone re-resolves).
  main.client.closeNow()
  await sleep(500)
  const offline = await phoneOutcome(host.relayHostId, resumeToken)
  await waitFor(() => offline.state.closed !== null, 2000)
  await seat('c10')
  const moved = await phoneOutcome(host.relayHostId, resumeToken)
  await waitFor(() => moved.state.closed !== null, 2000)
  await seat('edge')
  record('E2 missing seat: 4404 when assigned here, 4409 when assigned elsewhere', offline.state.closed === 4404 && moved.state.closed === 4409, `here=${offline.state.closed}(${offline.state.reason}) elsewhere=${moved.state.closed}`)

  // E2: revoke; the revoked token is now refused (4401).
  const back = control(host, jwt)
  const ack2 = await back.client.connect()
  back.attach(ack2.generation)
  const revoked = await back.client.revokeDevice('device-a').then(() => 'ok').catch((e: Error) => e.message)
  const afterRevoke = await phoneOutcome(host.relayHostId, resumeToken)
  await waitFor(() => afterRevoke.state.closed !== null, 2000)
  record('E2 device-revoke, then the revoked resume token is refused 4401', revoked === 'ok' && afterRevoke.state.closed === 4401, `revoke=${revoked} close=${afterRevoke.state.closed}`)

  // E2: database down. Phones get 4503 (never 4401), commands get control-error database_transient,
  // a new hello is closed 4429. Then the database comes back and phones are admitted again.
  const invite2 = await back.client.createInvite('device-b').catch((e: Error) => e)
  execSync(`pg_ctl -D ${PGDATA} -m fast stop`, { stdio: 'ignore' })
  try {
    const downPhone = await phoneOutcome(host.relayHostId, b64url(randomBytes(32)))
    await waitFor(() => downPhone.state.closed !== null, 8000)
    const downCmd = await back.client.createInvite('device-c').then(() => 'ok').catch((e: Error) => e.message)
    const fresh = control(host, jwt)
    await fresh.client.connect().catch(() => null)
    await waitFor(() => fresh.events.closes.length > 0, 8000)
    record(
      'E2 database down: phone 4503 (not 4401), command database_transient, new hello 4429',
      downPhone.state.closed === 4503 && /database_transient/.test(downCmd) && fresh.events.closes.includes(4429),
      `phone=${downPhone.state.closed} cmd=${downCmd} hello=${fresh.events.closes}`
    )
  } finally {
    execSync(`pg_ctl -D ${PGDATA} -o "-p ${PGPORT} -k /tmp" -l ${PGDATA}.log start`, { stdio: 'ignore' })
    await sleep(1500)
  }
  if (!(invite2 instanceof Error)) {
    const recovered = await phoneOutcome(host.relayHostId, invite2.inviteToken)
    record('E2 database back: invite phone admitted again', recovered.state.hello?.ok === true, JSON.stringify(recovered.state.hello))
    recovered.ws.close()
  }

  back.client.closeNow()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
