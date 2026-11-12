// Shared constants and helpers for mvp-object.ts: result recording, hosts and host JWTs, the
// shipped desktop control client, phone sockets and the director's signed admin calls.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SignJWT, type KeyLike } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/transports/relay-transport'

export const PORT = 8789
export const REMOTE = process.env.MVP_URL?.replace(/\/$/, '')
export const ORIGIN = REMOTE ?? `http://127.0.0.1:${PORT}`
export const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws')
export const SIGNING_KEY = process.env.MVP_KEY_FILE ? readFileSync(process.env.MVP_KEY_FILE, 'utf8').trim() : randomBytes(36).toString('base64url')
export const DIRECTOR = process.env.MVP_ISSUER ?? 'https://director.test.invalid'
export const ERASE_KEY = randomBytes(36).toString('base64url')
export const ERASER = 'https://api.erasure.test.invalid'
export const ISSUER = 'https://auth.test.invalid'
export const EPOCH = 7
export const USER = 'user-mvp'

export const results: { name: string; ok: boolean; detail: string }[] = []
export function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url')
export const sha = (s: string) => createHash('sha256').update(s).digest('base64url')
export async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) { return true }
    await sleep(25)
  }
  return cond()
}

export type Host = { relayHostId: string; keypair: { publicKey: Uint8Array; secretKey: Uint8Array; publicKeyB64: string } }

export function newHost(): Host {
  const box = nacl.box.keyPair()
  return {
    relayHostId: createHash('sha256').update(box.publicKey).digest('base64url').slice(0, 16),
    keypair: { publicKey: box.publicKey, secretKey: box.secretKey, publicKeyB64: Buffer.from(box.publicKey).toString('base64') }
  }
}

export async function mint(key: KeyLike, relayHostId: string, issuer = ISSUER, expiresIn = '5m'): Promise<string> {
  return new SignJWT({ purpose: 'host-control', prof: `prof-${USER}`, relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: REMOTE ? 'spike' : 'mvp' })
    .setSubject(USER)
    .setIssuer(issuer)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key)
}

// `drop` returns true for an outbound frame the test wants lost (a host that stops answering pings).
// `caps` replaces the shipped desktop's capability header (default: as shipped today).
export const SHIPPED_CAPS = 'pending-conn-details,idle-regional-rehome-v1'
export function control(host: Host, jwt: string, epoch = EPOCH, opts: { drop?: (frame: string) => boolean; caps?: string } = {}) {
  const events = { closes: [] as number[], opens: [] as { connId: string }[], drains: [] as Record<string, unknown>[], dropped: 0, pings: 0, offers: 0, acks: 0 }
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
    onDrain: (m) => events.drains.push(m as Record<string, unknown>),
    onClose: (code) => events.closes.push(code),
    createSocket: (url, token) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}`, 'x-orca-host-capabilities': opts.caps ?? process.env.MVP_HOST_CAPS ?? SHIPPED_CAPS },
        perMessageDeflate: false,
        maxPayload: 64 * 1024
      })
      ws.on('message', (raw) => {
        const type = (JSON.parse(raw.toString()) as { type?: unknown }).type
        if (type === 'ping') { events.pings++ }
        if (type === 'keepalive-offer') { events.offers++ }
        if (type === 'keepalive-ack') { events.acks++ }
      })
      const send = ws.send.bind(ws)
      ws.send = ((data: string, ...rest: never[]) => {
        if (opts.drop?.(String(data))) {
          events.dropped++
          return
        }
        send(data, ...rest)
      }) as typeof ws.send
      return ws
    }
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

export function phone(relayHostId: string, credential: string) {
  const ws = new WebSocket(`${WS_ORIGIN}/v1/connect/${relayHostId}`, { perMessageDeflate: false })
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

export async function phoneOutcome(relayHostId: string, credential: string) {
  const p = phone(relayHostId, credential)
  await waitFor(() => p.state.hello !== null || p.state.closed !== null, 8000)
  return p
}

// ---- director side: the signed admin calls (as the director will make them) ----
// Local only: the edge's second accepted director key (ADMIN_SIGNING_KEY_NEXT), for rotation.
export const NEXT_SIGNING_KEY = randomBytes(36).toString('base64url')
// `jti: null` signs without one (directors before single-use tokens); default: a fresh one.
export type AdminOpts = { key?: string; issuer?: string; tokenOp?: string; tokenBody?: string; jti?: string | null }
export async function adminToken(op: string, body: unknown, opts: AdminOpts = {}): Promise<string> {
  const jti = opts.jti === undefined ? randomBytes(18).toString('base64url') : opts.jti
  const raw = JSON.stringify(body)
  return new SignJWT({ purpose: 'edge-admin', op: opts.tokenOp ?? op, bodySha256: sha(opts.tokenBody ?? raw), ...(jti === null ? {} : { jti }) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.issuer ?? DIRECTOR)
    .setAudience('orca-relay-edge-admin')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(opts.key ?? SIGNING_KEY))
}
export async function adminSend(op: string, body: unknown, token: string) {
  const r = await fetch(`${ORIGIN}/__admin/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null }
}
export async function adminCall(op: string, body: unknown, opts: AdminOpts = {}) {
  return adminSend(op, body, await adminToken(op, body, opts))
}
export const assign = (relayHostId: string, cellId: string, assignmentEpoch: number, devices?: unknown[]) =>
  adminCall('assign', { userId: USER, relayHostId, cellId, assignmentEpoch, ...(devices ? { devices } : {}) })
