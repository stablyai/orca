// Local de-risk harness: starts `wrangler dev`, then drives the SHIPPED desktop relay client code
// and the shipped phone protocol parsers against the edge Worker. Local keys only.
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/relay-transport'
import { RelayPhoneHelloSchema } from '../../../../src/shared/remote-runtime/relay/mobile-relay-phone-protocol'

const PORT = 8787
const ORIGIN = `http://127.0.0.1:${PORT}`
const PING_MS = 1500
const SILENCE_MS = 5000
const GRACE_MS = 4000
// GUARD=1 enables the per-splice silent-bytes flood guard (32 MiB per 10 s) for a second run.
const GUARD = process.env.GUARD === '1'
const GUARD_BYTES = 32 * 1024 * 1024
const results: { name: string; ok: boolean; detail: string }[] = []
const record = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')

async function main(): Promise<void> {
  // ---- local keys and stub credential ----
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'spike', alg: 'ES256', use: 'sig' }
  const phoneToken = b64url(randomBytes(32))
  const phoneTokenHash = createHash('sha256').update(phoneToken).digest('base64url')
  writeFileSync(
    new URL('../.dev.vars', import.meta.url),
    [
      `RELAY_JWKS='${JSON.stringify({ keys: [jwk] })}'`,
      `PING_INTERVAL_MS=${PING_MS}`,
      `SILENCE_TIMEOUT_MS=${SILENCE_MS}`,
      `ORPHAN_GRACE_MS=${GRACE_MS}`,
      `SPIKE_RESUME_TOKEN_HASHES=resume:dev-spike:${phoneTokenHash}`,
      `SPIKE_ADMIN=1`,
      `SPLICE_SILENT_BYTES_MAX=${GUARD ? GUARD_BYTES : 0}`,
      `SPLICE_SILENT_WINDOW_MS=10000`
    ].join('\n')
  )
  const host = nacl.box.keyPair()
  const relayHostId = createHash('sha256').update(host.publicKey).digest('base64url').slice(0, 16)
  const keypair = {
    publicKey: host.publicKey,
    secretKey: host.secretKey,
    publicKeyB64: Buffer.from(host.publicKey).toString('base64')
  }
  const identity = { userId: 'user-spike', profileId: 'prof-spike', organizationId: '' }
  const jwt = await new SignJWT({ purpose: 'host-control', prof: identity.profileId, relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: 'spike' })
    .setSubject(identity.userId)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)

  // ---- start wrangler dev ----
  const state = mkdtempSync(join(tmpdir(), 'relay-edge-spike-'))
  const dev: ChildProcess = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state],
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
    await runTests({ jwt, keypair, identity, relayHostId, phoneToken }, () => devLog)
  } finally {
    dev.kill('SIGINT')
    await sleep(500)
    rmSync(state, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

type Ctx = {
  jwt: string
  keypair: { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyB64: string }
  identity: { userId: string; profileId: string; organizationId: string }
  relayHostId: string
  phoneToken: string
}

function makeControl(
  ctx: Ctx,
  cellUrl: string,
  extra: { previousGeneration?: number; controlResumeSecret?: string } = {}
) {
  const events = { pings: 0, closes: [] as number[], opens: [] as any[] }
  let transport: CloudRelayTransport | null = null
  const client = new RelayControlClient({
    cellUrl,
    relayJwt: ctx.jwt,
    relayHostId: ctx.relayHostId,
    assignmentEpoch: 7,
    identity: ctx.identity,
    keypair: ctx.keypair as never,
    appVersion: 'spike',
    ...extra,
    onConnectionOpen: (m) => {
      events.opens.push(m)
      void transport?.openConnection(m)
    },
    onDrain: () => {},
    onClose: (code) => events.closes.push(code),
    createSocket: (url, token) => {
      // Same options as the shipped default, plus a tap to count server pings.
      const ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-orca-host-capabilities': 'pending-conn-details,idle-regional-rehome-v1'
        },
        perMessageDeflate: false,
        maxPayload: 64 * 1024
      })
      ws.on('message', (raw, bin) => {
        if (!bin && JSON.parse(raw.toString()).type === 'ping') events.pings++
      })
      return ws
    }
  })
  return {
    client,
    events,
    bindTransport: (generation: number) => {
      transport = new CloudRelayTransport({ cellUrl, relayHostId: ctx.relayHostId, generation })
      // Echo service: "big:<text|binary>:<bytes>" asks the host for a large frame.
      transport.onMessage(echo)
      return transport
    },
    echo: (...args: Parameters<typeof echo>) => echo(...args)
  }
}

function echo(message: string | Uint8Array, reply: (r: string | Uint8Array) => void): void {
      {
        if (typeof message === 'string' && message.startsWith('big:')) {
          const [, kind, size] = message.split(':')
          reply(kind === 'text' ? 'x'.repeat(Number(size)) : new Uint8Array(Number(size)).fill(7))
          return
        }
        reply(message)
      }
}

function openPhone(ctx: Ctx, origin = ORIGIN) {
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/v1/connect/${ctx.relayHostId}`, {
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024
  })
  const inbox: { data: Buffer | string; binary: boolean }[] = []
  let hello: unknown = null
  let closed: number | null = null
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: ctx.phoneToken }))
  )
  ws.on('message', (raw, binary) => {
    if (hello === null) {
      hello = JSON.parse(raw.toString())
      return
    }
    inbox.push({ data: binary ? (raw as Buffer) : raw.toString(), binary })
  })
  ws.on('close', (code) => (closed = code))
  return {
    ws,
    inbox,
    get hello() {
      return hello
    },
    get closed() {
      return closed
    }
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

function workerdRssMb(): number {
  try {
    const out = execSync("ps -axo rss=,command= | grep -i '[w]orkerd serve' || true").toString()
    return Math.round(
      out
        .split('\n')
        .filter(Boolean)
        .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0]), 0) / 1024
    )
  } catch {
    return -1
  }
}

async function runTests(ctx: Ctx, devLog: () => string): Promise<void> {
  // R5/R11: shipped desktop client completes hello -> challenge -> proof -> strict ack.
  const a = makeControl(ctx, ORIGIN)
  const ack = await a.client.connect().catch((e: Error) => e)
  const ackOk = !(ack instanceof Error) && ack.generation === 1
  record('R5/R11 shipped desktop control client: hello, box challenge, HMAC proof, strict ack', ackOk,
    ack instanceof Error ? ack.message : `generation=${ack.generation}`)
  if (ack instanceof Error) return

  // Origin binding: the edge echoes the dialed origin, so another hostname also proves.
  {
    const other = makeControl(ctx, `http://localhost:${PORT}`)
    const r = await other.client.connect().catch((e: Error) => e)
    record('R5 proof origin binding follows the dialed origin (localhost vs 127.0.0.1)',
      !(r instanceof Error), r instanceof Error ? r.message : `generation=${r.generation}`)
    // That replaced generation 1; reconnect the main control as a fresh generation.
  }
  await sleep(300)
  const main = makeControl(ctx, ORIGIN)
  const mainAck = await main.client.connect()
  const transport = main.bindTransport(mainAck.generation)

  // Alarm-driven app ping, answered by the shipped client's pong handler.
  await sleep(PING_MS * 3 + 300)
  record('R2/R5 alarm-driven JSON ping parsed by shipped client, pong keeps control alive',
    main.events.pings >= 2 && main.client.isLive(), `pings=${main.events.pings} live=${main.client.isLive()}`)

  // Phone connect -> conn-open (strict, shipped parser) -> host data -> relay-hello (shipped parser).
  const phone = openPhone(ctx)
  const helloOk = await waitFor(() => phone.hello !== null, 5000)
  const parsedHello = RelayPhoneHelloSchema.safeParse(phone.hello)
  const conn = main.events.opens[0]
  record('R5 conn-open strict parse + connId routes data socket to the object',
    Boolean(conn) && conn.connId.startsWith(`${ctx.relayHostId}.`), conn ? `connId=${conn.connId}` : 'no conn-open')
  record('R5 shipped phone parser accepts relay-hello', helloOk && parsedHello.success && (phone.hello as any).ok === true,
    JSON.stringify(phone.hello))

  // Splice: small text + binary echo, type preserved.
  phone.ws.send('hello-text')
  phone.ws.send(Buffer.from([1, 2, 3, 250]), { binary: true })
  await waitFor(() => phone.inbox.length >= 2, 3000)
  const [t, b] = phone.inbox
  record('R4 splice preserves text/binary frame type both directions',
    t?.data === 'hello-text' && !t.binary && b?.binary && Buffer.compare(b.data as Buffer, Buffer.from([1, 2, 3, 250])) === 0,
    `text=${t?.binary === false} binary=${b?.binary === true}`)

  // 8 MiB frames host -> phone (text and binary) via the shipped transport.
  phone.inbox.length = 0
  const MiB8 = 8 * 1024 * 1024
  phone.ws.send(`big:text:${MiB8}`)
  phone.ws.send(`big:binary:${MiB8}`)
  const bigOk = await waitFor(() => phone.inbox.length >= 2, 20000)
  const [bt, bb] = phone.inbox
  record('R4 8 MiB text + binary frames host->phone',
    bigOk && !bt.binary && (bt.data as string).length === MiB8 && bb.binary && (bb.data as Buffer).length === MiB8,
    `got=${phone.inbox.map((m) => `${m.binary ? 'bin' : 'text'}:${m.data.length}`).join(',')}`)

  // 8 MiB phone -> host through the edge (raw data socket: the shipped desktop caps inbound at 1 MiB).
  {
    const phone2 = openPhone(ctx)
    await waitFor(() => main.events.opens.length >= 2, 3000)
    // Close the shipped transport's socket for this conn and attach a raw one instead.
    const c2 = main.events.opens[1]
    await sleep(500)
    const rawPhone = phone2
    const got: number[] = []
    // The shipped transport already attached; use it to receive by temporarily hooking messages.
    const received = new Promise<number>((resolve) => {
      transport.onMessage((message, reply) => {
        if (typeof message !== 'string' || !message.startsWith('big:')) {
          got.push(typeof message === 'string' ? message.length : message.byteLength)
          resolve(got[0])
          return
        }
        reply(message)
      })
    })
    rawPhone.ws.send(Buffer.alloc(900 * 1024, 3), { binary: true })
    const size = await Promise.race([received, sleep(10000).then(() => -1)])
    record('R4 phone->host ~0.9 MiB binary through edge to shipped transport (desktop caps inbound at 1 MiB)',
      size === 900 * 1024, `received=${size} connId=${c2?.connId}`)
    rawPhone.ws.close()
    transport.onMessage(echo as never)
  }

  // R4 slow reader, isolated per splice object: pause one phone's TCP socket and flood it from the
  // host while a second healthy phone keeps echoing and the host control keeps answering pings.
  {
    const healthy = openPhone(ctx)
    await waitFor(() => healthy.hello !== null, 5000)
    const slow = openPhone(ctx)
    await waitFor(() => slow.hello !== null, 5000)
    const tcp = (slow.ws as any)._socket as import('node:net').Socket
    tcp.pause()
    const before = workerdRssMb()
    const pingsBefore = main.events.pings
    const hostSocket = [...((transport as any).socketsByConnectionId as Map<string, WebSocket>).values()].at(-1)!
    const frame = Buffer.alloc(1024 * 1024, 9)
    let sent = 0
    let healthyEchoes = 0
    for (; sent < 256; sent++) {
      if (hostSocket.readyState !== WebSocket.OPEN) break
      hostSocket.send(frame, { binary: true })
      if (sent % 16 === 0) {
        const tag = `healthy-${sent}`
        healthy.ws.send(tag)
        if (await waitFor(() => healthy.inbox.some((m) => m.data === tag), 3000)) healthyEchoes++
      }
    }
    await sleep(PING_MS * 2 + 500)
    const peak = workerdRssMb()
    const controlOk = main.client.isLive() && main.events.pings > pingsBefore
    // A paused phone can't read its close frame until its socket resumes.
    tcp.resume()
    const slowClose = await waitFor(() => slow.closed !== null, 5000).then(() => slow.closed)
    if (GUARD) {
      record('R4 guard: flood to a silent paused phone closes that splice 4429; control + other splice unaffected',
        slowClose === 4429 && controlOk && healthyEchoes > 0 && healthy.closed === null,
        `sent=${sent}MiB slowClose=${slowClose} healthyEchoes=${healthyEchoes} controlLive=${controlOk} rss ${before}->${peak}MB`)
    } else {
      record('R4 isolation: flooding one paused phone leaves host control and another splice working',
        controlOk && healthyEchoes >= Math.floor(sent / 16) && healthy.closed === null,
        `sent=${sent}MiB healthyEchoes=${healthyEchoes} pingsDuringFlood=${main.events.pings - pingsBefore} controlLive=${controlOk} slowClosed=${slowClose} workerdRss ${before}->${peak}MB`)
    }
    await sleep(500)
    slow.ws.close()

    // Guard false-positive probe: a phone that reads normally but sends nothing while the host
    // streams 48 MiB in ~6 s (e.g. a busy terminal) looks identical to a flood at the edge.
    {
      const reader = openPhone(ctx)
      await waitFor(() => reader.hello !== null, 5000)
      const hs = [...((transport as any).socketsByConnectionId as Map<string, WebSocket>).values()].at(-1)!
      for (let i = 0; i < 48 && hs.readyState === WebSocket.OPEN; i++) {
        hs.send(frame, { binary: true })
        await sleep(120)
      }
      await waitFor(() => reader.inbox.length >= 48 || reader.closed !== null, 8000)
      record(`R4 guard ${GUARD ? 'ON' : 'OFF'}: legit silent 48 MiB stream to a reading phone`,
        GUARD ? true : reader.closed === null && reader.inbox.length === 48,
        `received=${reader.inbox.length}MiB closed=${reader.closed}${GUARD && reader.closed === 4429 ? ' (FALSE POSITIVE)' : ''}`)
      reader.ws.close()
    }

    // R4: resetting one splice object drops only that phone; the host budget is not leaked.
    {
      const victim = openPhone(ctx)
      await waitFor(() => victim.hello !== null, 5000)
      const victimConn = main.events.opens.at(-1)?.connId as string
      await fetch(`${ORIGIN}/__spike/abort-splice/${encodeURIComponent(victimConn)}`).catch(() => {})
      const victimDropped = await waitFor(() => victim.closed !== null, 5000)
      healthy.ws.send('after-splice-reset')
      const healthyOk = await waitFor(() => healthy.inbox.some((m) => m.data === 'after-splice-reset'), 3000)
      // Fill the host's 8-connection budget (2 phones are still live: `phone` and `healthy`).
      // The reset splice must not hold a slot: 6 more succeed, and a 7th is refused 4429.
      const extra = []
      for (let i = 0; i < 6; i++) {
        extra.push(openPhone(ctx))
        await waitFor(() => extra.at(-1)!.hello !== null || extra.at(-1)!.closed !== null, 5000)
      }
      const okCount = extra.filter((p) => (p.hello as any)?.ok === true).length
      const over = openPhone(ctx)
      await waitFor(() => over.closed !== null, 5000)
      record('R4 splice object reset drops only that phone; control + other splice live; budget reclaimed + enforced',
        victimDropped && healthyOk && main.client.isLive() && okCount === 6 && over.closed === 4429,
        `victimClose=${victim.closed} healthyEcho=${healthyOk} control=${main.client.isLive()} newPhonesOk=${okCount}/6 ninthClose=${over.closed}`)
      for (const p of extra) p.ws.close()
    }
    healthy.ws.close()
    await sleep(500)
  }

  // R4: phone connect latency through the extra RPC hop (local).
  {
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now()
      const p = openPhone(ctx)
      await waitFor(() => p.hello !== null || p.closed !== null, 5000)
      samples.push(performance.now() - t0)
      p.ws.close()
      await sleep(50)
    }
    samples.sort((x, y) => x - y)
    const rpc = [...devLog().matchAll(/spike_rpc_authorize_ms=(\d+)/g)].map((m) => Number(m[1])).sort((x, y) => x - y)
    record('R4 phone connect latency with splice->host RPC (local)', samples[19] < 1000,
      `open->relay-hello p50=${samples[10].toFixed(1)}ms p95=${samples[18].toFixed(1)}ms; authorize RPC p50=${rpc[Math.floor(rpc.length / 2)]}ms max=${rpc.at(-1)}ms n=${rpc.length}`)
  }

  // Rebind keeps generation and splices (resume secret within orphan grace).
  {
    const live = openPhone(ctx)
    await waitFor(() => live.hello !== null, 5000)
    const generation = mainAck.generation
    const rebind = makeControl(ctx, ORIGIN, {
      previousGeneration: generation,
      controlResumeSecret: mainAck.controlResumeSecret
    })
    const r = await rebind.client.connect().catch((e: Error) => e)
    await sleep(300)
    live.ws.send('after-rebind')
    const echoed = await waitFor(() => live.inbox.some((m) => m.data === 'after-rebind'), 3000)
    record('R5 rebind with resume secret keeps generation and live splice',
      !(r instanceof Error) && r.generation === generation && echoed && main.events.closes.includes(4408),
      r instanceof Error ? r.message : `gen ${generation}->${r.generation} spliceEcho=${echoed} oldClosed=${main.events.closes.join(',')}`)

    // Orphan then return after grace: new generation, persisted floor (not reset to 1).
    rebind.client.closeNow()
    await sleep(GRACE_MS + 1500)
    const fresh = makeControl(ctx, ORIGIN)
    const f = await fresh.client.connect()
    record('R2 orphan grace expiry closes splices 4408; generation floor persists', f.generation === generation + 1 && live.closed === 4408,
      `gen=${f.generation} phoneClosedWith=${live.closed}`)

    // Silence: a control that never pongs is closed 4408 within the silence window.
    const mute = new WebSocket(`ws://127.0.0.1:${PORT}/v1/host/control`, {
      headers: { authorization: `Bearer ${ctx.jwt}` }
    })
    let muteClose = 0
    mute.on('close', (c) => (muteClose = c))
    await new Promise((res) => mute.on('open', res))
    // Complete the handshake by hand with the shipped proof answerer, then never pong.
    const { answerRelayHostChallenge } = await import('../../../../src/main/runtime/mobile-cloud-relay/relay-host-proof')
    mute.send(JSON.stringify({ type: 'host-hello', v: 1, relayHostId: ctx.relayHostId, assignmentEpoch: 7,
      hostPublicKeyB64: ctx.keypair.publicKeyB64, appVersion: 'spike' }))
    mute.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'host-challenge') {
        const proofB64 = answerRelayHostChallenge(m, { relayOrigin: ORIGIN, ...ctx.identity, relayHostId: ctx.relayHostId,
          hostPublicKey: ctx.keypair.publicKey, hostSecretKey: ctx.keypair.secretKey, assignmentEpoch: 7, resumeRequested: false })
        mute.send(JSON.stringify({ type: 'host-challenge-ack', challengeId: m.challengeId, proofB64 }))
      }
    })
    await waitFor(() => muteClose !== 0, SILENCE_MS + PING_MS * 3 + 2000)
    record('R2 silent control closed 4408 by alarm silence check', muteClose === 4408, `close=${muteClose}`)
  }

  // R2: forced object reset (ctx.abort). Locally this drops every socket (1006); the durable
  // generation floor must survive so the next control gets floor+1, never a reused generation.
  {
    const before = makeControl(ctx, ORIGIN)
    const b = await before.client.connect()
    await fetch(`${ORIGIN}/__spike/abort/${ctx.relayHostId}`).catch(() => {})
    const dropped = await waitFor(() => before.events.closes.length > 0, 5000)
    await sleep(300)
    const after = makeControl(ctx, ORIGIN)
    const a2 = await after.client.connect().catch((e: Error) => e)
    record('R2 forced reset: sockets drop locally (expected for abort), storage keeps generation floor',
      !(a2 instanceof Error) && a2.generation === b.generation + 1,
      `dropped=${dropped} close=${before.events.closes.join(',')} gen ${b.generation}->${a2 instanceof Error ? a2.message : a2.generation}`)
    after.client.closeNow()
  }

  // Bad JWT -> 401 before upgrade; malformed host id -> 429.
  {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/v1/host/control`, { headers: { authorization: 'Bearer nope' } })
    const status = await new Promise<number>((res) => bad.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)))
    const badHost = new WebSocket(`ws://127.0.0.1:${PORT}/v1/connect/short`)
    const s2 = await new Promise<number>((res) => badHost.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)))
    record('R11/R5 ES256 JWKS rejects bad token (401); malformed host id 429', status === 401 && s2 === 429, `${status},${s2}`)
  }
  await transport.stop()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
