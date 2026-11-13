// Pooled splice objects: each host has up to SPLICE_SLOTS of them (`<relayHostId>.<slot>`), reused
// across phone connects so a connect never pays for creating a new object. An object holds the
// phone socket and host data socket of every splice in its slot (normally one; more only when the
// host's slot hint collides) and forwards frames between them. A slow or flooding phone can only
// exhaust (or get reset) its own slot's object, never the host's control socket or other slots.
import { DurableObject } from 'cloudflare:workers'
import { HostDataAuthSchema } from '../../../packages/relay-contract/src/control-messages'
import { RelayAuthSchema } from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { MESSAGE_TOO_BIG, frameOver, timingSafeEqualStr } from './bytes'
import type { Env } from './env'
import { metric } from './metrics'
import { parseConnId } from './splice-slot'

type State = {
  connId: string
  relayHostId: string
  phase: 'auth' | 'pending' | 'spliced'
  deadline: number
  connTicket?: string
  generation?: number
}
type SocketKind = 'phone' | 'data'
// Per-direction flood guard: bytes forwarded to a peer since that peer last sent anything.
// place: client ingress '<continent>/<colo>/<country>', for metrics.
// sentBytes/sentFrames: what this socket sent, kept on the attachment so it survives hibernation.
type GuardAttachment = { silentBytes: number; windowStart: number; place?: string; sentBytes?: number; sentFrames?: number }

const NO_DEADLINE = Number.MAX_SAFE_INTEGER
const KEY_PREFIX = 'splice:'

export class SpliceRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get('x-edge-kind')
    if (kind === 'abort' && this.env.SPIKE_ADMIN === '1') this.ctx.abort('spike reset')
    const connId = request.headers.get('x-edge-conn-id') ?? ''
    const parsed = parseConnId(connId)
    if (!parsed) return new Response(null, { status: 404 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    const now = Date.now()
    if (kind === 'phone') {
      if ((await this.state(connId)) !== undefined) return new Response(null, { status: 409 })
      await this.sweepOrphans()
      this.ctx.acceptWebSocket(server, ['phone', connId])
      const place = request.headers.get('x-edge-place') ?? undefined
      metric(this.env, 'phone_open', 1, '', [], '', place)
      server.serializeAttachment({ silentBytes: 0, windowStart: now, place } satisfies GuardAttachment)
      await this.save({
        connId,
        relayHostId: parsed.relayHostId,
        phase: 'auth',
        deadline: now + RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs
      })
    } else if (kind === 'data') {
      const state = await this.state(connId)
      if (!state || state.phase !== 'pending' || this.socket(connId, 'data')) {
        // Unknown or already-attached connection: same answer as a bad ticket.
        this.ctx.acceptWebSocket(server, ['reject'])
        server.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data ticket')
        return new Response(null, { status: 101, webSocket: client })
      }
      this.ctx.acceptWebSocket(server, ['data', connId])
      server.serializeAttachment({ silentBytes: 0, windowStart: now, place: request.headers.get('x-edge-place') ?? undefined } satisfies GuardAttachment)
    } else {
      return new Response(null, { status: 404 })
    }
    await this.reschedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const id = this.identify(ws)
    if (!id) return
    const state = await this.state(id.connId)
    if (!state) return
    if (state.phase === 'spliced') return this.forward(ws, id.connId, id.kind, message)
    if (id.kind === 'phone') {
      if (state.phase === 'auth') await this.onRelayAuth(ws, state, message)
      return // pending: the phone waits for relay-hello before sending E2EE frames
    }
    await this.onHostDataAuth(ws, state, message)
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.teardown(ws, code)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.teardown(ws, 1006)
  }

  // ---------------- RPC from HostRelay ----------------

  async closeSplice(connId: string, code: number, reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(connId)) this.close(ws, code, reason)
    await this.forget(connId)
    await this.reschedule()
  }

  async isAlive(connId: string): Promise<boolean> {
    if ((await this.state(connId)) === undefined) return false
    if (this.socket(connId, 'phone') !== null) return true
    await this.forget(connId) // its sockets died in a reset; drop the leftover state
    await this.reschedule()
    return false
  }

  // ---------------- phone auth ----------------

  private async onRelayAuth(ws: WebSocket, state: State, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'binary relay-auth')
      return
    }
    let credential: string
    try {
      const { type, ...rest } = JSON.parse(message) as Record<string, unknown>
      const auth = RelayAuthSchema.safeParse(rest)
      if (type !== 'relay-auth' || !auth.success) throw new Error('relay-auth')
      credential = auth.data.credential
    } catch {
      this.phoneFail(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
      return
    }
    const started = Date.now()
    const host = this.host(state.relayHostId)
    let result: Awaited<ReturnType<typeof host.authorizePhone>>
    try {
      result = await host.authorizePhone(state.connId, credential)
    } catch {
      // Transient edge failure must never look like a bad credential (4401 disables phones).
      this.phoneFail(ws, RELAY_CLOSE_CODE.DRAINING)
      return
    }
    if (this.env.SPIKE_ADMIN === '1') console.log(`spike_rpc_authorize_ms=${Date.now() - started}`)
    if (!result.ok) {
      this.phoneFail(ws, result.code, result.reason)
      return
    }
    await this.save({
      ...state,
      phase: 'pending',
      connTicket: result.connTicket,
      generation: result.generation,
      deadline: Date.now() + RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs
    })
    await this.reschedule()
  }

  // ---------------- host data auth ----------------

  private async onHostDataAuth(ws: WebSocket, state: State, message: string | ArrayBuffer): Promise<void> {
    let ok = false
    if (typeof message === 'string' && state.phase === 'pending') {
      try {
        const { type, ...body } = JSON.parse(message) as Record<string, unknown>
        const auth = HostDataAuthSchema.safeParse(body)
        ok =
          type === 'host-data-auth' &&
          auth.success &&
          timingSafeEqualStr(auth.data.connTicket, state.connTicket ?? '') &&
          auth.data.generation === state.generation
      } catch {
        ok = false
      }
    }
    const phone = this.socket(state.connId, 'phone')
    if (!ok || !phone) {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data ticket')
      return
    }
    // The host object persists the connection basis, then hands back the phone's relay-hello.
    const confirmed = await this.host(state.relayHostId)
      .confirmSplice(state.connId, state.generation ?? -1)
      .catch(() => ({ ok: false as const, code: RELAY_CLOSE_CODE.LIMIT_EXCEEDED }))
    if (!confirmed.ok) {
      if (confirmed.code === RELAY_CLOSE_CODE.LIMIT_EXCEEDED) {
        // As the cells when the basis write fails: both legs 4429.
        this.phoneFail(phone, RELAY_CLOSE_CODE.LIMIT_EXCEEDED)
        this.close(ws, RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'basis persistence failed')
        await this.forget(state.connId)
        await this.reschedule()
      } else {
        this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data ticket')
      }
      return
    }
    await this.save({ ...state, phase: 'spliced', connTicket: undefined, deadline: NO_DEADLINE })
    this.send(phone, { type: 'relay-hello', ...confirmed.hello })
    await this.reschedule()
  }

  // ---------------- splice ----------------

  private forward(from: WebSocket, connId: string, kind: SocketKind, message: string | ArrayBuffer): void {
    if (frameOver(message, RELAY_PROTOCOL_LIMITS.maxFrameBytes)) {
      for (const ws of this.ctx.getWebSockets(connId)) this.close(ws, MESSAGE_TOO_BIG, 'frame too large')
      return
    }
    const peer = this.socket(connId, kind === 'phone' ? 'data' : 'phone')
    if (!peer) return
    // The sender spoke, so its own inbound direction is evidently being read.
    const fromGuard = from.deserializeAttachment() as GuardAttachment
    const size = typeof message === 'string' ? message.length : message.byteLength
    from.serializeAttachment({
      ...fromGuard,
      ...(fromGuard.silentBytes !== 0 ? { silentBytes: 0, windowStart: Date.now() } : {}),
      sentBytes: (fromGuard.sentBytes ?? 0) + size,
      sentFrames: (fromGuard.sentFrames ?? 0) + 1
    })
    const budget = Number(this.env.SPLICE_SILENT_BYTES_MAX ?? '0')
    if (budget > 0) {
      const g = peer.deserializeAttachment() as GuardAttachment
      const windowMs = Number(this.env.SPLICE_SILENT_WINDOW_MS ?? '10000')
      const now = Date.now()
      const next =
        now - g.windowStart > windowMs
          ? { ...g, silentBytes: size, windowStart: now }
          : { ...g, silentBytes: g.silentBytes + size }
      peer.serializeAttachment(next)
      if (next.silentBytes > budget) {
        for (const ws of this.ctx.getWebSockets(connId)) this.close(ws, RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'splice flood')
        return
      }
    }
    try {
      peer.send(message)
    } catch {
      // Peer closing; teardown follows.
    }
  }

  // ---------------- lifecycle ----------------

  private async teardown(ws: WebSocket, code: number): Promise<void> {
    const id = this.identify(ws)
    if (!id) return
    const state = await this.state(id.connId)
    if (!state) return
    // [bytes to host, frames to host, bytes to phone, frames to phone], from each side's attachment.
    const sent = (k: SocketKind) => {
      const peer = k === id.kind ? ws : this.socket(id.connId, k)
      const g = peer?.deserializeAttachment() as GuardAttachment | undefined
      return [g?.sentBytes ?? 0, g?.sentFrames ?? 0]
    }
    const counters = [...sent('phone'), ...sent('data')]
    const place = this.place(ws)
    metric(this.env, 'phone_close', 1, `${id.kind}:${code}`, [], '', place)
    metric(this.env, 'splice_bytes', counters[0] + counters[2], '', counters, '', place)
    const reason = code === 1000 ? '' : 'peer dropped'
    for (const other of this.ctx.getWebSockets(id.connId)) {
      if (other !== ws) this.close(other, RELAY_CLOSE_CODE.PEER_DROPPED, reason)
    }
    await this.forget(id.connId)
    await this.reschedule()
    await this.host(state.relayHostId).spliceClosed(state.connId).catch(() => {})
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    for (const state of await this.states()) {
      if (now < state.deadline) continue
      const phone = this.socket(state.connId, 'phone')
      if (state.phase === 'pending') {
        // OTA phones redial this edge once, quickly: the control is still seated here.
        if (phone) this.phoneFail(phone, RELAY_CLOSE_CODE.HOST_OFFLINE, 'attach-timeout')
      } else if (phone) {
        this.close(phone, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
      }
      const data = this.socket(state.connId, 'data')
      if (data) this.close(data, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
      await this.forget(state.connId)
      await this.host(state.relayHostId).spliceClosed(state.connId).catch(() => {})
    }
    await this.reschedule()
  }

  private async reschedule(): Promise<void> {
    const next = Math.min(NO_DEADLINE, ...(await this.states()).map((s) => s.deadline))
    if (next === NO_DEADLINE) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1))
  }

  // ---------------- helpers ----------------

  private async state(connId: string): Promise<State | undefined> {
    return this.ctx.storage.get<State>(KEY_PREFIX + connId)
  }

  private async states(): Promise<State[]> {
    return [...(await this.ctx.storage.list<State>({ prefix: KEY_PREFIX })).values()]
  }

  private async save(state: State): Promise<void> {
    await this.ctx.storage.put<State>(KEY_PREFIX + state.connId, state)
  }

  // A reset drops sockets without close events. Every live splice has its phone socket from the
  // start, so state without one is left over and can go (the host prunes its own bookkeeping).
  private async sweepOrphans(): Promise<void> {
    for (const state of await this.states()) {
      if (this.socket(state.connId, 'phone') === null) await this.forget(state.connId)
    }
  }

  // Closed splices are deleted, not kept: the object is reused and connIds are never reused.
  private async forget(connId: string): Promise<void> {
    await this.ctx.storage.delete(KEY_PREFIX + connId)
  }

  private host(relayHostId: string) {
    return this.env.HOST_RELAY.get(this.env.HOST_RELAY.idFromName(relayHostId))
  }

  private identify(ws: WebSocket): { kind: SocketKind; connId: string } | null {
    const [kind, connId] = this.ctx.getTags(ws)
    if ((kind !== 'phone' && kind !== 'data') || !connId) return null
    return { kind, connId }
  }

  private socket(connId: string, kind: SocketKind): WebSocket | null {
    return this.ctx.getWebSockets(connId).find((ws) => this.ctx.getTags(ws)[0] === kind) ?? null
  }

  // As the cells' rejectClient: a strict relay-hello with only ok/code, the reason on the close.
  private phoneFail(ws: WebSocket, code: number, reason?: string): void {
    this.send(ws, { type: 'relay-hello', ok: false, code })
    this.close(ws, code, reason ?? 'relay connection rejected')
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // Socket already closing.
    }
  }

  private place(ws: WebSocket): string | undefined {
    try {
      return (ws.deserializeAttachment() as GuardAttachment | null)?.place
    } catch {
      return undefined
    }
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    const kind = this.identify(ws)?.kind ?? 'splice'
    metric(this.env, 'refuse', 1, `${kind}:${code}`, [], reason, this.place(ws))
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
