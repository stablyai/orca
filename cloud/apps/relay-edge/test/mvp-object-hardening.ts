// mvp-object.ts checks (local only) for control liveness on any inbound frame, the director's
// signed `drain` op, and the object health route.
import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KeyLike } from 'jose'
import { EPOCH, ORIGIN, adminCall, assign, control, mint, newHost, record, sleep, waitFor } from './harness-mvp-object'

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
