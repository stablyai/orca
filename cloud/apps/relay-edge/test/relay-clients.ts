// Shared by the local ingress end-to-end run and the G1 front-door check: the SHIPPED desktop
// control client and data transport, phone-like sockets, and the director's signed admin push.
import { createHash } from 'node:crypto'
import { get as httpsGet } from 'node:https'
import { SignJWT, type KeyLike } from 'jose'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { RelayControlClient } from '../../../../src/main/runtime/mobile-cloud-relay/relay-control-client'
import { CloudRelayTransport } from '../../../../src/main/runtime/rpc/relay-transport'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const sha = (s: string) => createHash('sha256').update(s).digest('base64url')
export async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(10)
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

export type Account = { user: string; epoch: number; jwtIssuer: string; jwtKid: string }

export function mint(account: Account, key: KeyLike, relayHostId: string): Promise<string> {
  return new SignJWT({ purpose: 'host-control', prof: `prof-${account.user}`, relayHostId })
    .setProtectedHeader({ alg: 'ES256', kid: account.jwtKid })
    .setSubject(account.user)
    .setIssuer(account.jwtIssuer)
    .setAudience('orca-relay')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(key)
}

// The desktop: shipped control client + shipped data transport, echoing every phone frame.
// `dialOrigin` sends the control socket somewhere other than `cellUrl` (negative controls), and
// `extraHeaders` adds headers to it. `events.serverPings` counts the edge's control pings.
export function desktop(
  account: Account,
  cellUrl: string,
  host: Host,
  jwt: string,
  opts: { dialOrigin?: string; extraHeaders?: Record<string, string>; appVersion?: string } = {}
) {
  const events = { closes: [] as number[], lastConnId: '', serverPings: 0, socketPongs: 0 }
  let transport: CloudRelayTransport | null = null
  const client = new RelayControlClient({
    cellUrl,
    relayJwt: jwt,
    relayHostId: host.relayHostId,
    assignmentEpoch: account.epoch,
    identity: { userId: account.user, profileId: `prof-${account.user}`, organizationId: '' },
    keypair: host.keypair as never,
    appVersion: opts.appVersion ?? 'ingress-e2e',
    onConnectionOpen: (m) => {
      events.lastConnId = m.connId
      void transport?.openConnection(m).catch(() => {})
    },
    onDrain: () => {},
    onClose: (code) => events.closes.push(code),
    createSocket: (url, token) => {
      const target = opts.dialOrigin ? url.replace(new URL(url).origin, opts.dialOrigin.replace(/^http/, 'ws')) : url
      const ws = new WebSocket(target, {
        headers: { authorization: `Bearer ${token}`, 'x-orca-host-capabilities': 'pending-conn-details', ...opts.extraHeaders },
        perMessageDeflate: false,
        maxPayload: 1024 * 1024 + 1024
      })
      ws.on('message', (raw) => {
        if (raw.toString().startsWith('{"type":"ping"')) events.serverPings++
      })
      ws.on('pong', () => events.socketPongs++)
      return ws
    }
  })
  return {
    client,
    events,
    async connect() {
      const ack = await client.connect()
      transport = new CloudRelayTransport({ cellUrl, relayHostId: host.relayHostId, generation: ack.generation })
      transport.onMessage(((m: string | Uint8Array, reply: (r: string | Uint8Array) => void) => reply(m)) as never)
      return ack
    }
  }
}

// A phone-like socket: auth frame, then the relay hello, then raw frames.
export function phone(origin: string, relayHostId: string, credential: string) {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/connect/${relayHostId}`, { perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 })
  const state = { hello: null as Record<string, unknown> | null, frames: [] as Buffer[], closed: null as number | null, closedAt: 0, reason: '' }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential })))
  ws.on('message', (raw) => {
    if (state.hello === null) state.hello = JSON.parse(raw.toString())
    else state.frames.push(raw as Buffer)
  })
  ws.on('close', (code, reason) => {
    state.closed = code
    state.closedAt = Date.now()
    state.reason = reason.toString()
  })
  ws.on('error', () => {})
  return { ws, state }
}
export async function phoneHello(origin: string, relayHostId: string, credential: string) {
  const p = phone(origin, relayHostId, credential)
  await waitFor(() => p.state.hello !== null || p.state.closed !== null, 8000)
  return p
}

// The director's push. It talks to the edge directly; front doors refuse admin paths.
export async function adminAssign(
  edge: string,
  admin: { key: string; issuer: string },
  account: Account,
  relayHostId: string,
  devices: unknown[] = []
) {
  const raw = JSON.stringify({ userId: account.user, relayHostId, cellId: 'edge', assignmentEpoch: account.epoch, devices })
  const token = await new SignJWT({ purpose: 'edge-admin', op: 'assign', bodySha256: sha(raw) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(admin.issuer)
    .setAudience('orca-relay-edge-admin')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(admin.key))
  const r = await fetch(`${edge}/__admin/assign`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: raw })
  return { status: r.status, ...((await r.json().catch(() => ({}))) as { outcome?: string }) }
}

// Pre-auth probe: a plain GET to the phone route is admitted (426) or limited (429).
export function preauthStatus(origin: string, relayHostId: string): Promise<number> {
  return new Promise((resolve) => {
    httpsGet(`${origin}/v1/connect/${relayHostId}`, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', () => resolve(-1))
  })
}

// A control socket with no usable JWT is refused before the upgrade.
export function unauthenticatedControl(origin: string): Promise<number> {
  return new Promise((res) => {
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/host/control`)
    ws.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0))
    ws.on('error', () => res(-1))
  })
}

// A control frame over 1 MiB closes 1009 (the JWT is valid; the frame is checked before the hello).
export function oversizeControl(origin: string, jwt: string): Promise<number> {
  const big = new WebSocket(`${origin.replace(/^http/, 'ws')}/v1/host/control`, { headers: { authorization: `Bearer ${jwt}` }, perMessageDeflate: false })
  big.on('error', () => {})
  return new Promise<number>((res) => {
    big.on('open', () => big.send('x'.repeat(1024 * 1024 + 1)))
    big.on('close', (c) => res(c))
    setTimeout(() => res(-1), 8000)
  })
}
