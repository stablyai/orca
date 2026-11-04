// One Durable Object per phone connection (connId). Owns the phone socket and the host data socket
// for that connection and forwards frames between them. Isolating each splice in its own object
// means a slow or flooding phone can only exhaust (or get reset) its own object, never the host's
// control socket or the host's other splices.
import { DurableObject } from 'cloudflare:workers'
import { HostDataAuthSchema } from '../../../packages/relay-contract/src/control-messages'
import { RelayAuthSchema } from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { timingSafeEqualStr } from './bytes'
import type { Env } from './env'

type State = {
  connId: string
  relayHostId: string
  phase: 'auth' | 'pending' | 'spliced' | 'closed'
  deadline: number
  connTicket?: string
  generation?: number
  credentialKind?: 'invite' | 'resume'
}
type SocketTag = 'phone' | 'data'
// Per-direction flood guard: bytes forwarded to a peer since that peer last sent anything.
type GuardAttachment = { silentBytes: number; windowStart: number }

const NO_DEADLINE = Number.MAX_SAFE_INTEGER

export class SpliceRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get('x-edge-kind')
    if (kind === 'abort') this.ctx.abort('spike reset')
    const connId = request.headers.get('x-edge-conn-id') ?? ''
    const relayHostId = connId.split('.', 1)[0]
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    const now = Date.now()
    if (kind === 'phone') {
      if ((await this.state()) !== undefined) return new Response(null, { status: 409 })
      this.ctx.acceptWebSocket(server, ['phone'])
      server.serializeAttachment({ silentBytes: 0, windowStart: now } satisfies GuardAttachment)
      await this.save({
        connId,
        relayHostId,
        phase: 'auth',
        deadline: now + RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs
      })
    } else if (kind === 'data') {
      const state = await this.state()
      if (!state || state.phase !== 'pending' || this.ctx.getWebSockets('data').length > 0) {
        // Unknown or already-attached connection: same answer as a bad ticket.
        this.ctx.acceptWebSocket(server, ['reject'])
        server.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data ticket')
        return new Response(null, { status: 101, webSocket: client })
      }
      this.ctx.acceptWebSocket(server, ['data'])
      server.serializeAttachment({ silentBytes: 0, windowStart: now } satisfies GuardAttachment)
    } else {
      return new Response(null, { status: 404 })
    }
    await this.reschedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tag = this.tag(ws)
    const state = await this.state()
    if (!state || !tag) return
    if (state.phase === 'spliced') return this.forward(ws, tag, message)
    if (tag === 'phone') {
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

  async closeSplice(code: number, reason: string): Promise<void> {
    const state = await this.state()
    for (const ws of this.ctx.getWebSockets()) this.close(ws, code, reason)
    if (state && state.phase !== 'closed') await this.save({ ...state, phase: 'closed', deadline: NO_DEADLINE })
    await this.ctx.storage.deleteAlarm()
  }

  async isAlive(): Promise<boolean> {
    const state = await this.state()
    return state !== undefined && state.phase !== 'closed' && this.ctx.getWebSockets('phone').length > 0
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
    const host = this.env.HOST_RELAY.get(this.env.HOST_RELAY.idFromName(state.relayHostId))
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
      this.phoneFail(ws, result.code)
      return
    }
    await this.save({
      ...state,
      phase: 'pending',
      connTicket: result.connTicket,
      generation: result.generation,
      credentialKind: result.kind,
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
    if (ok) {
      const host = this.env.HOST_RELAY.get(this.env.HOST_RELAY.idFromName(state.relayHostId))
      ok = await host.confirmSplice(state.connId, state.generation ?? -1).catch(() => false)
    }
    const phone = this.ctx.getWebSockets('phone')[0]
    if (!ok || !phone) {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data ticket')
      return
    }
    await this.save({ ...state, phase: 'spliced', connTicket: undefined, deadline: NO_DEADLINE })
    const now = Date.now()
    this.send(
      phone,
      state.credentialKind === 'invite'
        ? { type: 'relay-hello', ok: true, credentialKind: 'invite', leaseExpiresAt: now + 15_000 }
        : {
            type: 'relay-hello',
            ok: true,
            credentialKind: 'resume',
            leaseExpiresAt: now + 10_000,
            acceptedCredentialVersion: 1,
            acceptedAs: 'current',
            resumeExpiresAt: now + RELAY_PROTOCOL_LIMITS.resumeTtlMs
          }
    )
    await this.reschedule()
  }

  // ---------------- splice ----------------

  private forward(from: WebSocket, tag: SocketTag, message: string | ArrayBuffer): void {
    const peer = this.ctx.getWebSockets(tag === 'phone' ? 'data' : 'phone')[0]
    if (!peer) return
    // The sender spoke, so its own inbound direction is evidently being read.
    const fromGuard = from.deserializeAttachment() as GuardAttachment
    if (fromGuard.silentBytes !== 0) from.serializeAttachment({ silentBytes: 0, windowStart: Date.now() })
    const budget = Number(this.env.SPLICE_SILENT_BYTES_MAX ?? '0')
    if (budget > 0) {
      const g = peer.deserializeAttachment() as GuardAttachment
      const size = typeof message === 'string' ? message.length : message.byteLength
      const windowMs = Number(this.env.SPLICE_SILENT_WINDOW_MS ?? '10000')
      const now = Date.now()
      const next =
        now - g.windowStart > windowMs
          ? { silentBytes: size, windowStart: now }
          : { silentBytes: g.silentBytes + size, windowStart: g.windowStart }
      peer.serializeAttachment(next)
      if (next.silentBytes > budget) {
        for (const ws of this.ctx.getWebSockets()) this.close(ws, RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'splice flood')
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
    const tag = this.tag(ws)
    const state = await this.state()
    if (!state || state.phase === 'closed' || tag === null) return
    const reason = code === 1000 ? '' : 'peer dropped'
    for (const other of this.ctx.getWebSockets()) if (other !== ws) this.close(other, RELAY_CLOSE_CODE.PEER_DROPPED, reason)
    await this.save({ ...state, phase: 'closed', deadline: NO_DEADLINE })
    await this.ctx.storage.deleteAlarm()
    const host = this.env.HOST_RELAY.get(this.env.HOST_RELAY.idFromName(state.relayHostId))
    await host.spliceClosed(state.connId).catch(() => {})
  }

  async alarm(): Promise<void> {
    const state = await this.state()
    if (!state || state.phase === 'closed' || Date.now() < state.deadline) return this.reschedule()
    const phone = this.ctx.getWebSockets('phone')[0]
    if (state.phase === 'pending') {
      if (phone) this.close(phone, RELAY_CLOSE_CODE.HOST_OFFLINE, 'attach-timeout')
    } else if (phone) {
      this.close(phone, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
    }
    for (const ws of this.ctx.getWebSockets('data')) this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
    await this.save({ ...state, phase: 'closed', deadline: NO_DEADLINE })
    const host = this.env.HOST_RELAY.get(this.env.HOST_RELAY.idFromName(state.relayHostId))
    await host.spliceClosed(state.connId).catch(() => {})
  }

  private async reschedule(): Promise<void> {
    const state = await this.state()
    if (!state || state.deadline === NO_DEADLINE) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(Math.max(state.deadline, Date.now() + 1))
  }

  // ---------------- helpers ----------------

  private async state(): Promise<State | undefined> {
    return this.ctx.storage.get<State>('splice')
  }

  private async save(state: State): Promise<void> {
    await this.ctx.storage.put<State>('splice', state)
  }

  private tag(ws: WebSocket): SocketTag | null {
    const tags = this.ctx.getTags(ws)
    return tags.includes('phone') ? 'phone' : tags.includes('data') ? 'data' : null
  }

  private phoneFail(ws: WebSocket, code: number): void {
    this.send(ws, { type: 'relay-hello', ok: false, code })
    this.close(ws, code, '')
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // Socket already closing.
    }
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
