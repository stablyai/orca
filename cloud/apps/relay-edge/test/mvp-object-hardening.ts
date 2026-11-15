// mvp-object.ts checks (local only) for control liveness on any inbound frame, the director's
// signed `drain` op, and the object health route.
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KeyLike } from 'jose'
import { EPOCH, ORIGIN, SHIPPED_CAPS, adminCall, assign, control, mint, newHost, record, sleep, waitFor } from './harness-mvp-object'

// Local timing (mvp-object.ts): ping every 3 s, silence timeout 9 s.
const SILENCE_MS = 9_000

// F4: a control that answers no pings but keeps sending other frames stays up past the silence
// timeout; a fully silent one is closed 4408.
export async function heartbeatCheck(key: KeyLike): Promise<void> {
  const chattyHost = newHost()
  const silentHost = newHost()
  await Promise.all([assign(chattyHost.relayHostId, 'edge', EPOCH, []), assign(silentHost.relayHostId, 'edge', EPOCH, [])])
  const chattyJwt = await mint(key, chattyHost.relayHostId)
  let muted = false
  const isPong = (frame: string) => (JSON.parse(frame) as { type?: unknown }).type === 'pong'
  const chatty = control(chattyHost, chattyJwt, EPOCH, { drop: (frame) => muted && isPong(frame) })
  const silent = control(silentHost, await mint(key, silentHost.relayHostId), EPOCH, { drop: () => muted })
  await Promise.all([chatty.client.connect(), silent.client.connect()])
  muted = true
  const started = Date.now()
  const refresher = setInterval(() => chatty.client.refreshAuthorization(chattyJwt), 2_000)
  try {
    const silentClosed = await waitFor(() => silent.events.closes.length > 0, SILENCE_MS + 8_000)
    const silentAfter = Date.now() - started
    // Past the timeout plus a full ping interval for the chatty one, whenever the silent one went.
    await sleep(Math.max(0, started + SILENCE_MS + 4_000 - Date.now()))
    record(
      'F4 a control answering no pings but sending other frames stays up past the silence timeout',
      chatty.events.closes.length === 0 && chatty.client.isLive() && chatty.events.dropped >= 2,
      `up=${Date.now() - started}ms droppedPongs=${chatty.events.dropped} closes=${chatty.events.closes}`
    )
    record(
      'F4 a fully silent control still closes 4408',
      silentClosed && silent.events.closes.includes(4408),
      `closedAfter=${silentAfter}ms closes=${silent.events.closes}`
    )
  } finally {
    clearInterval(refresher)
    chatty.client.closeNow()
    silent.client.closeNow()
  }
}

// K1: host-sent keepalive. A host advertising client-keepalive-v1 gets the offer, then sends the
// keepalive, which the runtime answers: the edge sends it no pings and it stays up. One that goes
// silent is not watched by any alarm while idle, but is closed 4408 the moment the director needs
// the host (export), and a live one is not. A host without the capability is pinged as before.
export async function keepaliveCheck(key: KeyLike): Promise<void> {
  const caps = `${SHIPPED_CAPS},client-keepalive-v1`
  const liveHost = newHost()
  const silentHost = newHost()
  const legacyHost = newHost()
  await Promise.all([liveHost, silentHost, legacyHost].map((h) => assign(h.relayHostId, 'edge', EPOCH, [])))
  let muted = false
  const live = control(liveHost, await mint(key, liveHost.relayHostId), EPOCH, { caps })
  const silent = control(silentHost, await mint(key, silentHost.relayHostId), EPOCH, { caps, drop: () => muted })
  const legacy = control(legacyHost, await mint(key, legacyHost.relayHostId))
  // Its keepalive timer stalls (a throttled app) but it still answers relay pings from socket I/O.
  const nappingHost = newHost()
  await assign(nappingHost.relayHostId, 'edge', EPOCH, [])
  const napping = control(nappingHost, await mint(key, nappingHost.relayHostId), EPOCH, { caps, drop: (f) => muted && f === '{"type":"keepalive"}' })
  await Promise.all([live.client.connect(), silent.client.connect(), legacy.client.connect(), napping.client.connect()])
  try {
    await sleep(1_000)
    muted = true
    await sleep(SILENCE_MS + 4_000)
    record(
      'K1 keepalive host: offered, answered, no edge pings, up past the silence timeout',
      live.events.offers === 1 && live.events.acks >= 3 && live.events.pings === 0 && live.client.isLive() && live.events.closes.length === 0,
      `offers=${live.events.offers} acks=${live.events.acks} pings=${live.events.pings} closes=${live.events.closes}`
    )
    record(
      'K1 host without the capability: no offer, pinged as before',
      legacy.events.offers === 0 && legacy.events.pings >= 3 && legacy.client.isLive(),
      `offers=${legacy.events.offers} pings=${legacy.events.pings}`
    )
    // Local sweep alarm every 3 s: it finds the napping host silent and probes it with a relay ping.
    record(
      'K2 keepalive host with a stalled timer: probed with a relay ping, answers, stays up',
      napping.events.pings >= 1 && napping.client.isLive() && napping.events.closes.length === 0,
      `pings=${napping.events.pings} dropped=${napping.events.dropped} closes=${napping.events.closes}`
    )
    const nappingExport = await adminCall('export', { relayHostId: nappingHost.relayHostId })
    record('K2 export of the probed, answering host: busy', nappingExport.json?.outcome === 'busy', JSON.stringify(nappingExport.json?.outcome))
    const liveExport = await adminCall('export', { relayHostId: liveHost.relayHostId })
    const silentExport = await adminCall('export', { relayHostId: silentHost.relayHostId })
    await waitFor(() => silent.events.closes.length > 0, 3_000)
    record(
      'K1 export: live keepalive host busy; silent one closed 4408 and exported',
      liveExport.json?.outcome === 'busy' && silentExport.json?.outcome === 'exported' && silent.events.closes.includes(4408) && live.events.closes.length === 0,
      `live=${JSON.stringify(liveExport.json?.outcome)} silent=${JSON.stringify(silentExport.json?.outcome)} closes=${silent.events.closes}`
    )
  } finally {
    live.client.closeNow()
    silent.client.closeNow()
    legacy.client.closeNow()
    napping.client.closeNow()
  }
}

// K3: a keepalive host that goes fully silent is probed when an alarm runs (here the local 3 s
// sweep; in production the silence check armed while phones are attached), and closed 4408 when
// the probe goes unanswered: silence timeout plus the 10 s probe.
export async function keepaliveProbeCheck(key: KeyLike): Promise<void> {
  const host = newHost()
  await assign(host.relayHostId, 'edge', EPOCH, [])
  let muted = false
  const c = control(host, await mint(key, host.relayHostId), EPOCH, { caps: `${SHIPPED_CAPS},client-keepalive-v1`, drop: () => muted })
  await c.client.connect()
  muted = true
  const started = Date.now()
  try {
    const closed = await waitFor(() => c.events.closes.length > 0, SILENCE_MS + 10_000 + 8_000)
    const after = Date.now() - started
    record(
      'K3 silent keepalive host: probed, then closed 4408 after the silence timeout plus the probe',
      closed && c.events.closes.includes(4408) && c.events.pings >= 1 && after >= SILENCE_MS + 10_000 - 500,
      `closedAfter=${after}ms pings=${c.events.pings} closes=${c.events.closes}`
    )
  } finally {
    c.client.closeNow()
  }
}

// K4: a keepalive host gone silent when its authorization expires closes as a dropped host (4408),
// not 4401, so edge drop counts stay comparable with the cells (their pings would have closed it).
export async function keepaliveExpiredSilentCheck(key: KeyLike): Promise<void> {
  const host = newHost()
  await assign(host.relayHostId, 'edge', EPOCH, [])
  const started = Date.now()
  // Alive for 50 s, then silent: the silence probe (sent ~9 s later) is still pending when the
  // 3 s token passes its 60 s grace at ~63 s, so the expiry check is what closes it.
  const c = control(host, await mint(key, host.relayHostId, undefined, '3s'), EPOCH, {
    caps: `${SHIPPED_CAPS},client-keepalive-v1`,
    drop: () => Date.now() - started > 50_000
  })
  await c.client.connect()
  try {
    const closed = await waitFor(() => c.events.closes.length > 0, 3_000 + 60_000 + 15_000)
    const after = Date.now() - started
    record(
      'K4 silent keepalive host at token expiry: closed 4408 (not 4401)',
      closed && c.events.closes.includes(4408) && !c.events.closes.includes(4401) && after >= 59_000,
      `closedAfter=${after}ms pings=${c.events.pings} closes=${c.events.closes}`
    )
  } finally {
    c.client.closeNow()
  }
}

// F5: POST /__admin/drain sends the host's controls back to the director (drain frame, 4503).
export async function drainCheck(key: KeyLike): Promise<void> {
  const host = newHost()
  const id = host.relayHostId
  const forged = await adminCall('drain', { relayHostId: id }, { key: randomBytes(36).toString('base64url') })
  const otherOp = await adminCall('drain', { relayHostId: id }, { tokenOp: 'export' })
  const badBody = await adminCall('drain', { relayHostId: 'short' })
  record('F5 drain: forged key 401, token for another op 401, bad body 400', forged.status === 401 && otherOp.status === 401 && badBody.status === 400, `${forged.status}/${otherOp.status}/${badBody.status}`)
  const idle = await adminCall('drain', { relayHostId: id })
  record('F5 drain with no control: 200 idle', idle.status === 200 && idle.json?.outcome === 'idle', `${idle.status}:${JSON.stringify(idle.json)}`)
  await assign(id, 'edge', EPOCH, [])
  const live = control(host, await mint(key, id))
  await live.client.connect()
  const drained = await adminCall('drain', { relayHostId: id })
  // Straight after the drain: the closing control must not make the export answer busy.
  const exported = await adminCall('export', { relayHostId: id })
  record('F5 export right after a drain: exported, not busy', exported.json?.outcome === 'exported', `${exported.status}:${JSON.stringify(exported.json?.outcome)}`)
  await waitFor(() => live.events.closes.length > 0, 3_000)
  const frame = live.events.drains[0]
  record(
    'F5 drain with a live control: 200 drained, control gets the drain frame and 4503',
    drained.status === 200 && drained.json?.outcome === 'drained' && drained.json?.controls === 1 &&
      frame?.recovery === 'resolve-director' && frame?.graceMs === 0 && live.events.closes.includes(4503),
    `${drained.status}:${JSON.stringify(drained.json)} drain=${JSON.stringify(frame)} closes=${live.events.closes}`
  )
  const after = await adminCall('drain', { relayHostId: id })
  record('F5 drain again after the control left: idle', after.json?.outcome === 'idle', JSON.stringify(after.json))
}

// H1: GET /__health/object reads the canary object's storage and answers 200 {ok:true}; it writes
// nothing, only GET is served, and it is limited per source like the other unauthenticated routes.
export async function objectHealthCheck(stateDir: string): Promise<void> {
  const list = () => readdirSync(stateDir, { recursive: true }).map(String).filter((f) => f.endsWith('.sqlite'))
  const beforeList = new Set(list())
  const first = await fetch(`${ORIGIN}/__health/object`)
  const body = (await first.json().catch(() => null)) as { ok?: unknown } | null
  const post = (await fetch(`${ORIGIN}/__health/object`, { method: 'POST' })).status
  const tables = list()
    .filter((f) => !beforeList.has(f))
    .flatMap((f) => {
      const db = new DatabaseSync(join(stateDir, f), { readOnly: true })
      try {
        return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)).filter((name) => !name.startsWith('__'))
      } finally {
        db.close()
      }
    })
  record(
    'H1 object health: 200 {ok:true}, POST 405, nothing written to object storage',
    first.status === 200 && body?.ok === true && post === 405 && tables.length === 0,
    `status=${first.status} body=${JSON.stringify(body)} post=${post} tables=${tables.join(',') || 'none'}`
  )
  const statuses: number[] = []
  for (let i = 0; i < 70; i++) { statuses.push((await fetch(`${ORIGIN}/__health/object`)).status) }
  record('H1 object health past the per-source limit: 429', statuses.at(-1) === 429, `limitedFrom=${statuses.indexOf(429)}`)
}
