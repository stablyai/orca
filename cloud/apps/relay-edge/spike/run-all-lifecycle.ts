// Later run-all.ts checks against the same host: splice pool slots, connect latency, rebind,
// orphan grace, silence, forced resets and pre-upgrade refusals.
import WebSocket from 'ws'
import { GRACE_MS, ORIGIN, PING_MS, PORT, SILENCE_MS, makeControl, openPhone, record, sleep, waitFor, type Ctx, type Control } from './run-all-harness'

type Ack = Awaited<ReturnType<Control['client']['connect']>>

export async function runLifecycleChecks(ctx: Ctx, main: Control, mainAck: Ack, devLog: () => string): Promise<void> {
  // Pool: concurrent phones get distinct slots of the host's splice pool, and every connId names a
  // pooled object (`<relayHostId>.<slot>`), so connects reuse objects instead of creating them.
  {
    const opensBefore = main.events.opens.length
    const batch = [openPhone(ctx), openPhone(ctx), openPhone(ctx), openPhone(ctx)]
    await waitFor(() => batch.every((p) => p.hello !== null || p.closed !== null), 8000)
    const ids = main.events.opens.slice(opensBefore).map((o: { connId: string }) => o.connId)
    const slotOf = (id: string) => id.match(new RegExp(`^${ctx.relayHostId}\\.([0-7])\\.[0-9a-f-]{36}$`))?.[1]
    const slots = ids.map(slotOf)
    const ok = batch.every((p) => (p.hello as { ok?: unknown } | null)?.ok === true)
    record('Pool: concurrent phones land in distinct pooled slots (connId <host>.<slot>.<uuid>)',
      ok && ids.length === 4 && slots.every((s) => s !== undefined) && new Set(slots).size === 4,
      `slots=${slots.join(',')} hellos=${batch.map((p) => (p.hello as { ok?: unknown } | null)?.ok).join(',')}`)
    for (const p of batch) { p.ws.close() }
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

  // F1: after a forced reset (no close events), a desktop that rebinds within the grace keeps its
  // generation, so splices living in SpliceRelay objects are not torn down.
  {
    const before = makeControl(ctx, ORIGIN)
    const b = await before.client.connect()
    await fetch(`${ORIGIN}/__spike/abort/${ctx.relayHostId}`).catch(() => {})
    await waitFor(() => before.events.closes.length > 0, 5000)
    await sleep(300)
    const back = makeControl(ctx, ORIGIN, {
      previousGeneration: b.generation,
      controlResumeSecret: b.controlResumeSecret
    })
    const r = await back.client.connect().catch((e: Error) => e)
    record('F1 rebind after forced reset keeps generation',
      !(r instanceof Error) && r.generation === b.generation,
      r instanceof Error ? r.message : `gen ${b.generation}->${r.generation}`)
    back.client.closeNow()
  }

  // Bad JWT -> 401 before upgrade; malformed host id -> 429.
  {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/v1/host/control`, { headers: { authorization: 'Bearer nope' } })
    const status = await new Promise<number>((res) => bad.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)))
    const badHost = new WebSocket(`ws://127.0.0.1:${PORT}/v1/connect/short`)
    const s2 = await new Promise<number>((res) => badHost.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)))
    record('R11/R5 ES256 JWKS rejects bad token (401); malformed host id 429', status === 401 && s2 === 429, `${status},${s2}`)
  }
}
