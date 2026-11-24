// Local de-risk harness: starts `wrangler dev`, then drives the SHIPPED desktop relay client code
// and the shipped phone protocol parsers against the edge Worker. Local keys only.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import type { Socket } from 'node:net'
import { RelayPhoneHelloSchema } from '../../../../src/shared/remote-runtime/relay/mobile-relay-phone-protocol'
import { GRACE_MS, GUARD, GUARD_BYTES, ORIGIN, PING_MS, PORT, SILENCE_MS, b64url, makeControl, openPhone, record, results, sleep, waitFor, workerdRssMb, type Ctx } from './run-all-harness'
import { runLifecycleChecks } from './run-all-lifecycle'

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
      `SPLICE_SILENT_WINDOW_MS=10000`,
      `EDGE_BACKEND=spike`
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
        if ((await fetch(`${ORIGIN}/health`)).ok) { break }
      } catch {}
      if (i > 120) { throw new Error(`wrangler dev did not start:\n${devLog}`) }
      await sleep(500)
    }
    await runTests({ jwt, keypair, identity, relayHostId, phoneToken })
  } finally {
    dev.kill('SIGINT')
    await sleep(500)
    rmSync(state, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) { process.exitCode = 1 }
}

async function runTests(ctx: Ctx): Promise<void> {
  // R5/R11: shipped desktop client completes hello -> challenge -> proof -> strict ack.
  const a = makeControl(ctx, ORIGIN)
  const ack = await a.client.connect().catch((e: Error) => e)
  const ackOk = !(ack instanceof Error) && ack.generation === 1
  record('R5/R11 shipped desktop control client: hello, box challenge, HMAC proof, strict ack', ackOk,
    ack instanceof Error ? ack.message : `generation=${ack.generation}`)
  if (ack instanceof Error) { return }

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

  // Phone connect -> conn-open (strict, shipped parser) -> host data -> relay-hello (shipped parser).
  const phone = openPhone(ctx)
  const helloOk = await waitFor(() => phone.hello !== null, 5000)
  const parsedHello = RelayPhoneHelloSchema.safeParse(phone.hello)
  record('R5 shipped phone parser accepts relay-hello', helloOk && parsedHello.success && (phone.hello as { ok?: unknown } | null)?.ok === true,
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

  // R4 slow reader, isolated per splice object: pause one phone's TCP socket and flood it from the
  // host while a second healthy phone keeps echoing and the host control keeps answering pings.
  {
    const healthy = openPhone(ctx)
    await waitFor(() => healthy.hello !== null, 5000)
    const slow = openPhone(ctx)
    await waitFor(() => slow.hello !== null, 5000)
    const tcp = (slow.ws as unknown as { _socket: Socket })._socket
    tcp.pause()
    const before = workerdRssMb()
    const pingsBefore = main.events.pings
    const hostSocket = [...(transport as unknown as { socketsByConnectionId: Map<string, WebSocket> }).socketsByConnectionId.values()].at(-1)!
    const frame = Buffer.alloc(1024 * 1024, 9)
    let sent = 0
    let healthyEchoes = 0
    for (; sent < 256; sent++) {
      if (hostSocket.readyState !== WebSocket.OPEN) { break }
      hostSocket.send(frame, { binary: true })
      if (sent % 16 === 0) {
        const tag = `healthy-${sent}`
        healthy.ws.send(tag)
        if (await waitFor(() => healthy.inbox.some((m) => m.data === tag), 3000)) { healthyEchoes++ }
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
      const okCount = extra.filter((p) => (p.hello as { ok?: unknown } | null)?.ok === true).length
      const over = openPhone(ctx)
      await waitFor(() => over.closed !== null, 5000)
      record('R4 splice object reset drops only that phone; control + other splice live; budget reclaimed + enforced',
        victimDropped && healthyOk && main.client.isLive() && okCount === 6 && over.closed === 4429,
        `victimClose=${victim.closed} healthyEcho=${healthyOk} control=${main.client.isLive()} newPhonesOk=${okCount}/6 ninthClose=${over.closed}`)
      for (const p of extra) { p.ws.close() }
    }
    healthy.ws.close()
    await sleep(500)
  }

  await runLifecycleChecks(ctx, main, mainAck)
  await transport.stop()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
