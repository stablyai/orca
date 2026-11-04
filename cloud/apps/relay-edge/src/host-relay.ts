// One Durable Object per relay host. Owns the host control socket, the session (generation,
// resume secret, orphan grace) and the host's connection bookkeeping. Each phone connection and its
// host data socket live in their own SpliceRelay object, so a flooding phone cannot reset this one.
// The control socket uses the Hibernation API; durable state lives in object storage.
import { DurableObject } from 'cloudflare:workers'
import nacl from 'tweetnacl'
import {
  buildHostChallengePlaintext,
  buildHostProofMacInput,
  buildHostProofTranscript
} from '../../../packages/relay-contract/src/host-proof-transcript'
import {
  HostChallengeAckSchema,
  HostHelloSchema,
  RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS,
  parseRelayHostCapabilities
} from '../../../packages/relay-contract/src/control-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { verifyRelayJwt } from './jwt'
import { metric } from './metrics'
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
type Attachment = ControlAttachment
type Conn = {
  phase: 'pending' | 'active'
  generation: number
  connTicket?: string
  kind: 'invite' | 'resume'
  relayDeviceId: string
}

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
    if (kind === 'info') {
      const session = await this.ctx.storage.get<Session>('session')
      return Response.json({
        version: this.env.EDGE_VERSION ?? 'dev',
        generation: session?.generation ?? null,
        controls: this.ctx.getWebSockets('control').length,
        conns: Object.keys(await this.conns()).length
      })
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
    } else {
      return new Response(null, { status: 404 })
    }
    await this.reschedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.attachment(ws)
    if (!a) return
    return this.onControl(ws, a, message)
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
      if (typeof body.t === 'number') metric(this.env, 'pong_rtt_ms', a.lastPongAt - body.t)
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
      await this.closeSplices(() => true, RELAY_CLOSE_CODE.PEER_DROPPED, 'host control replaced')
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
    for (const [connId, c] of Object.entries(await this.conns())) {
      if (c.phase === 'active') activeConnIds.push(connId)
      if (c.phase === 'pending' && c.connTicket && c.generation === generation) {
        pendingConns.push({
          connId,
          connTicket: c.connTicket,
          ...(details ? { kind: c.kind, relayDeviceId: c.relayDeviceId } : {})
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
    metric(this.env, 'control_active', 1, rebind ? 'rebind' : 'new')
    await this.reschedule()
  }

  private activeControl(): { ws: WebSocket; a: ControlAttachment } | null {
    for (const ws of this.ctx.getWebSockets('control')) {
      const a = this.attachment(ws)
      if (a?.k === 'control' && a.phase === 'active') return { ws, a }
    }
    return null
  }

  // ---------------- RPC from SpliceRelay ----------------

  // Phone presented relay-auth to its splice object. Checks the credential and the host's
  // connection budget, records the pending connection and sends conn-open on the control socket.
  async authorizePhone(
    connId: string,
    credentialToken: string
  ): Promise<
    | { ok: true; connTicket: string; generation: number; kind: 'invite' | 'resume'; relayDeviceId: string }
    | { ok: false; code: number }
  > {
    const credential = await this.resolveCredential(credentialToken)
    if (!credential) return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL }
    const control = this.activeControl()
    if (!control || control.a.generation === undefined) {
      return { ok: false, code: RELAY_CLOSE_CODE.HOST_OFFLINE }
    }
    const conns = await this.conns()
    if (Object.keys(conns).length >= RELAY_PROTOCOL_LIMITS.maxConnectionsPerHost) {
      await this.pruneDeadConns(conns)
      if (Object.keys(conns).length >= RELAY_PROTOCOL_LIMITS.maxConnectionsPerHost) {
        return { ok: false, code: RELAY_CLOSE_CODE.LIMIT_EXCEEDED }
      }
    }
    const connTicket = b64url(nacl.randomBytes(32))
    conns[connId] = {
      phase: 'pending',
      generation: control.a.generation,
      connTicket,
      kind: credential.kind,
      relayDeviceId: credential.relayDeviceId
    }
    await this.ctx.storage.put('conns', conns)
    this.send(control.ws, {
      type: 'conn-open',
      connId,
      connTicket,
      kind: credential.kind,
      relayDeviceId: credential.relayDeviceId,
      attachDeadlineMs: RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs
    })
    return { ok: true, connTicket, generation: control.a.generation, ...credential }
  }

  // Host data socket presented a valid ticket to the splice object.
  async confirmSplice(connId: string, generation: number): Promise<boolean> {
    const conns = await this.conns()
    const conn = conns[connId]
    if (!conn || conn.phase !== 'pending' || conn.generation !== generation) return false
    if (this.activeControl()?.a.generation !== generation) return false
    conns[connId] = { ...conn, phase: 'active', connTicket: undefined }
    await this.ctx.storage.put('conns', conns)
    return true
  }

  async spliceClosed(connId: string): Promise<void> {
    const conns = await this.conns()
    if (!(connId in conns)) return
    delete conns[connId]
    await this.ctx.storage.put('conns', conns)
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

  private async conns(): Promise<Record<string, Conn>> {
    return (await this.ctx.storage.get<Record<string, Conn>>('conns')) ?? {}
  }

  // A splice object that was reset never reports its close. Ask before refusing on the budget.
  private async pruneDeadConns(conns: Record<string, Conn>): Promise<void> {
    const ids = Object.keys(conns)
    const alive = await Promise.all(ids.map((id) => this.splice(id).isAlive().catch(() => false)))
    ids.forEach((id, i) => {
      if (!alive[i]) delete conns[id]
    })
    await this.ctx.storage.put('conns', conns)
  }

  private splice(connId: string) {
    return this.env.SPLICE_RELAY.get(this.env.SPLICE_RELAY.idFromName(connId))
  }

  private async closeSplices(filter: (c: Conn) => boolean, code: number, reason: string): Promise<void> {
    const conns = await this.conns()
    const ids = Object.keys(conns).filter((id) => filter(conns[id]))
    await Promise.all(ids.map((id) => this.splice(id).closeSplice(code, reason).catch(() => {})))
    for (const id of ids) delete conns[id]
    await this.ctx.storage.put('conns', conns)
  }

  // ---------------- lifecycle ----------------

  private async onSocketGone(ws: WebSocket, _code: number): Promise<void> {
    const a = this.attachment(ws)
    if (!a) return
    // During webSocketClose the closing socket is still listed; clear it first so it can't count as live.
    this.attach(ws, null)
    if (a.k === 'control' && a.phase === 'active') metric(this.env, 'control_close', 1, String(_code))
    if (a.k === 'control' && a.phase === 'active' && !this.activeControl()) {
      const session = await this.ctx.storage.get<Session>('session')
      if (session && session.generation === a.generation) {
        await this.ctx.storage.put<Session>('session', { ...session, orphanedAt: Date.now() })
      }
      // Pending phones have nobody to attach them.
      await this.closeSplices((c) => c.phase === 'pending', RELAY_CLOSE_CODE.HOST_OFFLINE, '')
    }
    await this.reschedule()
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
          if (a.lastPingAt) metric(this.env, 'alarm_lag_ms', Math.max(0, now - (a.lastPingAt + this.pingIntervalMs)))
          this.send(ws, { type: 'ping', t: now })
          a.lastPingAt = now
          this.attach(ws, a)
        }
        continue
      }
      if (now >= a.deadline) {
        this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
        await this.onSocketGone(ws, 1006)
      }
    }
    const session = await this.ctx.storage.get<Session>('session')
    if (
      session?.orphanedAt != null &&
      !this.activeControl() &&
      now - session.orphanedAt >= this.orphanGraceMs
    ) {
      await this.closeSplices(() => true, RELAY_CLOSE_CODE.PEER_DROPPED, 'host control lost')
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
