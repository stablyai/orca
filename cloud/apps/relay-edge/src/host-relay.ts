// One Durable Object per relay host. Owns the host control socket, phone sockets, host data
// sockets and their splices. Every socket uses the Hibernation API; all per-socket state lives
// in attachments and durable session state lives in object storage, so nothing depends on memory.
import { DurableObject } from 'cloudflare:workers'
import nacl from 'tweetnacl'
import {
  buildHostChallengePlaintext,
  buildHostProofMacInput,
  buildHostProofTranscript
} from '../../../packages/relay-contract/src/host-proof-transcript'
import {
  HostChallengeAckSchema,
  HostDataAuthSchema,
  HostHelloSchema,
  RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS,
  parseRelayHostCapabilities
} from '../../../packages/relay-contract/src/control-messages'
import { RelayAuthSchema } from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { verifyRelayJwt } from './jwt'
import type { EdgeClaims, Env } from './env'
import { b64, b64url, fromB64, hmacSha256, sha256B64url, timingSafeEqualStr } from './bytes'

type ControlAttachment = {
  k: 'control'
  phase: 'hello' | 'proof' | 'active'
  claims: EdgeClaims
  origin: string
  caps: string[]
  deadline: number
  challengeId?: string
  expectedProof?: string
  hello?: { previousGeneration?: number; controlResumeSecret?: string }
  generation?: number
  lastPongAt?: number
  lastPingAt?: number
}
type PhoneAttachment = {
  k: 'phone'
  phase: 'auth' | 'pending' | 'spliced'
  deadline: number
  connId?: string
  connTicket?: string
  generation?: number
  credentialKind?: 'invite' | 'resume'
  relayDeviceId?: string
}
type DataAttachment = { k: 'data'; phase: 'auth' | 'spliced'; deadline: number; connId: string }
type Attachment = ControlAttachment | PhoneAttachment | DataAttachment

type Session = {
  generation: number
  resumeSecretHash: string
  userId: string
  profileId: string
  organizationId: string
  orphanedAt: number | null
}

const NO_DEADLINE = Number.MAX_SAFE_INTEGER
const LEASE_MS = 6 * 60 * 60 * 1000

export class HostRelay extends DurableObject<Env> {
  private get pingIntervalMs(): number {
    return Number(this.env.PING_INTERVAL_MS)
  }
  private get silenceTimeoutMs(): number {
    return Number(this.env.SILENCE_TIMEOUT_MS)
  }
  private get orphanGraceMs(): number {
    return Number(this.env.ORPHAN_GRACE_MS)
  }

  async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get('x-edge-kind')
    if (kind === 'abort') {
      this.ctx.abort('spike reset')
    }
    const origin = request.headers.get('x-edge-origin') ?? ''
    const now = Date.now()
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    if (kind === 'control') {
      const claims = JSON.parse(request.headers.get('x-edge-claims') ?? 'null') as EdgeClaims
      this.ctx.acceptWebSocket(server, ['control'])
      this.attach(server, {
        k: 'control',
        phase: 'hello',
        claims,
        origin,
        caps: [...parseRelayHostCapabilities(request.headers.get('x-orca-host-capabilities') ?? '')],
        deadline: now + RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs
      })
    } else if (kind === 'phone') {
      this.ctx.acceptWebSocket(server, ['phone'])
      this.attach(server, {
        k: 'phone',
        phase: 'auth',
        deadline: now + RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs
      })
    } else if (kind === 'data') {
      const connId = request.headers.get('x-edge-conn-id') ?? ''
      this.ctx.acceptWebSocket(server, ['data', `data:${connId}`])
      this.attach(server, {
        k: 'data',
        phase: 'auth',
        connId,
        deadline: now + RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs
      })
    } else {
      return new Response(null, { status: 404 })
    }
    await this.reschedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.attachment(ws)
    if (!a) return
    if (a.k === 'control') return this.onControl(ws, a, message)
    if (a.k === 'phone') return this.onPhone(ws, a, message)
    return this.onData(ws, a, message)
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.onSocketGone(ws, code)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws, 1006)
  }

  // ---------------- control ----------------

  private async onControl(
    ws: WebSocket,
    a: ControlAttachment,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== 'string') {
      if (a.phase !== 'active') this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'binary hello')
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(message) as Record<string, unknown>
    } catch {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid control json')
      return
    }
    const { type, ...body } = parsed
    if (a.phase === 'hello') return this.onHostHello(ws, a, type, body)
    if (a.phase === 'proof') return this.onHostProof(ws, a, type, body)
    if (type === 'pong') {
      a.lastPongAt = Date.now()
      this.attach(ws, a)
      return
    }
    if (type === 'auth-refresh') {
      const claims = await verifyRelayJwt(this.env, String(body.relayJwt ?? ''))
      const same =
        claims &&
        claims.userId === a.claims.userId &&
        claims.profileId === a.claims.profileId &&
        claims.organizationId === a.claims.organizationId &&
        claims.relayHostId === a.claims.relayHostId
      if (!same) {
        this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'refresh identity changed')
        return
      }
      a.claims = claims
      this.attach(ws, a)
      return
    }
    // Credential/invite commands need the shared credential store (Hyperdrive); not in this spike.
    const reqId = typeof body.reqId === 'string' ? body.reqId : undefined
    this.send(ws, { type: 'control-error', ...(reqId ? { reqId } : {}), code: 'unsupported' })
  }

  private async onHostHello(
    ws: WebSocket,
    a: ControlAttachment,
    type: unknown,
    body: Record<string, unknown>
  ): Promise<void> {
    const hello = HostHelloSchema.safeParse(body)
    if (type !== 'host-hello' || !hello.success) {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host hello')
      return
    }
    const hostPublicKey = fromB64(hello.data.hostPublicKeyB64)
    const keyHostId = (await sha256B64url(hostPublicKey)).slice(0, 16)
    if (hello.data.relayHostId !== a.claims.relayHostId || keyHostId !== a.claims.relayHostId) {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'host key binding mismatch')
      return
    }
    // Spike: the director's epoch check (signed lease or assignment row) is out of scope.
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 10_000
    const ephemeral = nacl.box.keyPair()
    const nonce = nacl.randomBytes(24)
    const challengeId = crypto.randomUUID()
    const secret = nacl.randomBytes(32)
    const transcript = buildHostProofTranscript({
      relayOrigin: a.origin,
      relayEphemeralPublicKey: ephemeral.publicKey,
      challengeNonce: nonce,
      challengeId,
      issuedAt,
      expiresAt,
      userId: a.claims.userId,
      profileId: a.claims.profileId,
      organizationId: a.claims.organizationId,
      relayHostId: a.claims.relayHostId,
      hostPublicKey,
      assignmentEpoch: hello.data.assignmentEpoch,
      previousGeneration: hello.data.previousGeneration,
      resumeRequested: Boolean(hello.data.controlResumeSecret)
    })
    const ciphertext = nacl.box(
      buildHostChallengePlaintext(transcript, secret),
      nonce,
      hostPublicKey,
      ephemeral.secretKey
    )
    a.phase = 'proof'
    a.deadline = expiresAt
    a.challengeId = challengeId
    a.expectedProof = b64(await hmacSha256(secret, buildHostProofMacInput(transcript)))
    a.hello = {
      previousGeneration: hello.data.previousGeneration,
      controlResumeSecret: hello.data.controlResumeSecret
    }
    this.attach(ws, a)
    this.send(ws, {
      type: 'host-challenge',
      challengeId,
      relayEphemeralPublicKeyB64: b64(ephemeral.publicKey),
      nonceB64: b64(nonce),
      ciphertextB64: b64(ciphertext),
      expiresAt
    })
    await this.reschedule()
  }

  private async onHostProof(
    ws: WebSocket,
    a: ControlAttachment,
    type: unknown,
    body: Record<string, unknown>
  ): Promise<void> {
    const ack = HostChallengeAckSchema.safeParse(body)
    if (
      type !== 'host-challenge-ack' ||
      !ack.success ||
      ack.data.challengeId !== a.challengeId ||
      Date.now() > a.deadline ||
      !timingSafeEqualStr(ack.data.proofB64, a.expectedProof ?? '')
    ) {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host proof')
      return
    }
    const now = Date.now()
    const stored = await this.ctx.storage.get<Session>('session')
    const sameIdentity =
      stored !== undefined &&
      stored.userId === a.claims.userId &&
      stored.profileId === a.claims.profileId &&
      stored.organizationId === a.claims.organizationId
    const otherControls = this.ctx
      .getWebSockets('control')
      .filter((s) => s !== ws && this.attachment(s)?.k === 'control')
      .filter((s) => (this.attachment(s) as ControlAttachment).phase === 'active')
    const withinGrace =
      stored !== undefined &&
      (otherControls.length > 0 ||
        (stored.orphanedAt !== null && now - stored.orphanedAt <= this.orphanGraceMs))
    const secret = a.hello?.controlResumeSecret
    const rebind =
      stored !== undefined &&
      sameIdentity &&
      withinGrace &&
      secret !== undefined &&
      a.hello?.previousGeneration === stored.generation &&
      timingSafeEqualStr(await sha256B64url(new TextEncoder().encode(secret)), stored.resumeSecretHash)

    let generation: number
    let resumeSecret: string
    if (rebind) {
      generation = stored.generation
      resumeSecret = secret
      for (const old of otherControls) this.close(old, RELAY_CLOSE_CODE.PEER_DROPPED, 'control rebound')
    } else {
      generation = (stored?.generation ?? 0) + 1
      resumeSecret = b64url(nacl.randomBytes(32))
      for (const old of otherControls) {
        this.close(old, RELAY_CLOSE_CODE.PEER_DROPPED, 'replaced by a newer generation')
      }
      this.closeAllSplices(RELAY_CLOSE_CODE.PEER_DROPPED, 'host control replaced')
    }
    await this.ctx.storage.put<Session>('session', {
      generation,
      resumeSecretHash: await sha256B64url(new TextEncoder().encode(resumeSecret)),
      userId: a.claims.userId,
      profileId: a.claims.profileId,
      organizationId: a.claims.organizationId,
      orphanedAt: null
    })
    a.phase = 'active'
    a.generation = generation
    a.lastPongAt = now
    a.lastPingAt = now
    a.deadline = NO_DEADLINE
    delete a.expectedProof
    delete a.hello
    this.attach(ws, a)
    const details = a.caps.includes(RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS)
    const activeConnIds: string[] = []
    const pendingConns: Record<string, unknown>[] = []
    for (const phone of this.ctx.getWebSockets('phone')) {
      const p = this.attachment(phone) as PhoneAttachment
      if (p.phase === 'spliced' && p.connId) activeConnIds.push(p.connId)
      if (p.phase === 'pending' && p.connId && p.connTicket) {
        pendingConns.push({
          connId: p.connId,
          connTicket: p.connTicket,
          ...(details ? { kind: p.credentialKind, relayDeviceId: p.relayDeviceId } : {})
        })
      }
    }
    this.send(ws, {
      type: 'host-hello-ack',
      v: 1,
      generation,
      controlResumeSecret: resumeSecret,
      leaseExpiresAt: now + LEASE_MS,
      activeConnIds: activeConnIds.slice(0, 8),
      pendingConns: pendingConns.slice(0, 8)
    })
    await this.reschedule()
  }

  private activeControl(): { ws: WebSocket; a: ControlAttachment } | null {
    for (const ws of this.ctx.getWebSockets('control')) {
      const a = this.attachment(ws)
      if (a?.k === 'control' && a.phase === 'active') return { ws, a }
    }
    return null
  }

  // ---------------- phone ----------------

  private async onPhone(
    ws: WebSocket,
    a: PhoneAttachment,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (a.phase === 'spliced') {
      const peer = a.connId ? this.ctx.getWebSockets(`data:${a.connId}`)[0] : undefined
      peer?.send(message)
      return
    }
    if (a.phase === 'pending') return // the phone waits for relay-hello before E2EE frames
    if (typeof message !== 'string') {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'binary relay-auth')
      return
    }
    let body: Record<string, unknown>
    try {
      const { type, ...rest } = JSON.parse(message) as Record<string, unknown>
      if (type !== 'relay-auth') throw new Error('type')
      body = rest
    } catch {
      this.phoneFail(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
      return
    }
    const auth = RelayAuthSchema.safeParse(body)
    if (!auth.success) {
      this.phoneFail(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
      return
    }
    const credential = await this.resolveCredential(auth.data.credential)
    if (!credential) {
      this.phoneFail(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
      return
    }
    const control = this.activeControl()
    if (!control) {
      this.phoneFail(ws, RELAY_CLOSE_CODE.HOST_OFFLINE)
      return
    }
    const live = this.ctx
      .getWebSockets('phone')
      .filter((s) => (this.attachment(s) as PhoneAttachment).phase !== 'auth')
    if (live.length >= RELAY_PROTOCOL_LIMITS.maxConnectionsPerHost) {
      this.phoneFail(ws, RELAY_CLOSE_CODE.LIMIT_EXCEEDED)
      return
    }
    const relayHostId = control.a.claims.relayHostId
    a.connId = `${relayHostId}.${crypto.randomUUID()}`
    a.connTicket = b64url(nacl.randomBytes(32))
    a.phase = 'pending'
    a.generation = control.a.generation
    a.credentialKind = credential.kind
    a.relayDeviceId = credential.relayDeviceId
    a.deadline = Date.now() + RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs
    this.attach(ws, a)
    this.send(control.ws, {
      type: 'conn-open',
      connId: a.connId,
      connTicket: a.connTicket,
      kind: credential.kind,
      relayDeviceId: credential.relayDeviceId,
      attachDeadlineMs: RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs
    })
    await this.reschedule()
  }

  // Spike stub. Production reads relay_devices / relay_invites through Hyperdrive.
  private async resolveCredential(
    token: string
  ): Promise<{ kind: 'invite' | 'resume'; relayDeviceId: string } | null> {
    const hash = await sha256B64url(new TextEncoder().encode(token))
    for (const entry of (this.env.SPIKE_RESUME_TOKEN_HASHES ?? '').split(',')) {
      const [kind, relayDeviceId, expected] = entry.split(':')
      if (expected && timingSafeEqualStr(hash, expected)) {
        return { kind: kind === 'invite' ? 'invite' : 'resume', relayDeviceId }
      }
    }
    return null
  }

  private phoneFail(ws: WebSocket, code: number, reason = ''): void {
    this.send(ws, { type: 'relay-hello', ok: false, code })
    this.close(ws, code, reason)
  }

  private phoneByConnId(connId: string): { ws: WebSocket; a: PhoneAttachment } | null {
    for (const ws of this.ctx.getWebSockets('phone')) {
      const a = this.attachment(ws) as PhoneAttachment
      if (a.connId === connId) return { ws, a }
    }
    return null
  }

  // ---------------- host data ----------------

  private async onData(
    ws: WebSocket,
    a: DataAttachment,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (a.phase === 'spliced') {
      this.phoneByConnId(a.connId)?.ws.send(message)
      return
    }
    const phone = this.phoneByConnId(a.connId)
    let ok = false
    if (typeof message === 'string' && phone && phone.a.phase === 'pending') {
      try {
        const { type, ...body } = JSON.parse(message) as Record<string, unknown>
        const auth = HostDataAuthSchema.safeParse(body)
        ok =
          type === 'host-data-auth' &&
          auth.success &&
          timingSafeEqualStr(auth.data.connTicket, phone.a.connTicket ?? '') &&
          auth.data.generation === phone.a.generation &&
          this.activeControl()?.a.generation === auth.data.generation
      } catch {
        ok = false
      }
    }
    if (!ok || !phone) {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data ticket')
      return
    }
    a.phase = 'spliced'
    a.deadline = NO_DEADLINE
    this.attach(ws, a)
    phone.a.phase = 'spliced'
    phone.a.deadline = NO_DEADLINE
    delete phone.a.connTicket
    this.attach(phone.ws, phone.a)
    const now = Date.now()
    this.send(
      phone.ws,
      phone.a.credentialKind === 'invite'
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

  // ---------------- lifecycle ----------------

  private async onSocketGone(ws: WebSocket, code: number): Promise<void> {
    const a = this.attachment(ws)
    if (!a) return
    // During webSocketClose the closing socket is still listed; clear it first so it can't count as live.
    this.attach(ws, null)
    if (a.k === 'control' && a.phase === 'active') {
      if (!this.activeControl()) {
        const session = await this.ctx.storage.get<Session>('session')
        if (session && session.generation === a.generation) {
          await this.ctx.storage.put<Session>('session', { ...session, orphanedAt: Date.now() })
        }
        // Pending phones have nobody to attach them.
        for (const phone of this.ctx.getWebSockets('phone')) {
          const p = this.attachment(phone) as PhoneAttachment
          if (p.phase === 'pending') this.close(phone, RELAY_CLOSE_CODE.HOST_OFFLINE, '')
        }
      }
    } else if (a.k === 'phone' && a.connId) {
      for (const data of this.ctx.getWebSockets(`data:${a.connId}`)) {
        this.close(data, RELAY_CLOSE_CODE.PEER_DROPPED, 'peer dropped')
      }
    } else if (a.k === 'data' && a.phase === 'spliced') {
      const phone = this.phoneByConnId(a.connId)
      if (phone) this.close(phone.ws, RELAY_CLOSE_CODE.PEER_DROPPED, code === 1000 ? '' : 'peer dropped')
    }
    await this.reschedule()
  }

  private closeAllSplices(code: number, reason: string): void {
    for (const ws of [...this.ctx.getWebSockets('phone'), ...this.ctx.getWebSockets('data')]) {
      const a = this.attachment(ws)
      if (a && a.k !== 'control' && a.phase !== 'auth') this.close(ws, code, reason)
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws)
      if (!a) continue
      if (a.k === 'control' && a.phase === 'active') {
        if (now - (a.lastPongAt ?? now) > this.silenceTimeoutMs) {
          this.close(ws, RELAY_CLOSE_CODE.PEER_DROPPED, 'control silence timeout')
          await this.onSocketGone(ws, RELAY_CLOSE_CODE.PEER_DROPPED)
          continue
        }
        if (now - (a.lastPingAt ?? 0) >= this.pingIntervalMs - 50) {
          this.send(ws, { type: 'ping', t: now })
          a.lastPingAt = now
          this.attach(ws, a)
        }
        continue
      }
      if (now >= a.deadline) {
        if (a.k === 'phone' && a.phase === 'pending') {
          this.close(ws, RELAY_CLOSE_CODE.HOST_OFFLINE, 'attach-timeout')
        } else {
          this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
        }
        await this.onSocketGone(ws, 1006)
      }
    }
    const session = await this.ctx.storage.get<Session>('session')
    if (
      session?.orphanedAt != null &&
      !this.activeControl() &&
      now - session.orphanedAt >= this.orphanGraceMs
    ) {
      this.closeAllSplices(RELAY_CLOSE_CODE.PEER_DROPPED, 'host control lost')
      await this.ctx.storage.put<Session>('session', { ...session, orphanedAt: null })
    }
    await this.reschedule()
  }

  private async reschedule(): Promise<void> {
    let next = NO_DEADLINE
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws)
      if (!a) continue
      if (a.k === 'control' && a.phase === 'active') {
        next = Math.min(next, (a.lastPingAt ?? 0) + this.pingIntervalMs)
      } else {
        next = Math.min(next, a.deadline)
      }
    }
    const session = await this.ctx.storage.get<Session>('session')
    if (session?.orphanedAt != null) next = Math.min(next, session.orphanedAt + this.orphanGraceMs)
    if (next === NO_DEADLINE) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > next || current < Date.now()) {
      await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1))
    }
  }

  // ---------------- helpers ----------------

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  }

  private attach(ws: WebSocket, a: Attachment | null): void {
    ws.serializeAttachment(a)
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
