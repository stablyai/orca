// One Durable Object per relay host. Owns the host control socket, the session (generation,
// resume secret, orphan grace), the host's connection bookkeeping and its credential commands.
// Phone connections and their host data sockets live in a pool of SpliceRelay objects (one per
// slot, reused across connects), so a flooding phone cannot reset this one and a connect never
// creates a new object. The control socket uses the Hibernation API; durable state lives in object
// storage; credentials and assignments are the relay's Postgres tables, through Hyperdrive.
import { DurableObject } from 'cloudflare:workers'
import nacl from 'tweetnacl'
import {
  buildHostChallengePlaintext,
  buildHostProofMacInput,
  buildHostProofTranscript
} from '../../../packages/relay-contract/src/host-proof-transcript'
import {
  AuthRefreshSchema,
  DeviceRevokeSchema,
  HostChallengeAckSchema,
  HostHelloSchema,
  InviteCreateSchema,
  RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS,
  parseRelayHostCapabilities
} from '../../../packages/relay-contract/src/control-messages'
import {
  DeviceCredentialInstallSchema,
  DeviceCredentialInstallStatusSchema,
  DeviceResumeConfirmSchema,
  type RelayHello
} from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { CONTROL_CONTINUITY_LIMITS } from '../../../packages/relay-contract/src/control-continuity'
import { ASSIGNMENT_LIMITS } from '../../../packages/relay-contract/src/assignment-invariants'
import { relayHostCloseReasonFrom } from '../../../packages/relay-contract/src/host-close-reason'
import { verifyRelayJwt } from './jwt'
import { SPLICE_SLOTS, makeConnId, parseConnId } from './splice-slot'
import { metric } from './metrics'
import { RelayCredentialStore } from '../../relay/src/credential-store'
import type { AssignBody, DeviceRow } from './admin'
import { ObjectStore, type AssignResult, type StoredAssignment } from './object-store'
import { edgeConfig, type EdgeClaims, type EdgeConfig, type Env } from './env'
import { controlErrorCode, edgeBackend, type CredentialReservation, type EdgeBackend } from './edge-backend'
import { CONTROL_MAX_FRAME_BYTES, MESSAGE_TOO_BIG, b64, b64url, frameOver, fromB64, hmacSha256, sha256B64url, timingSafeEqualStr } from './bytes'

// Longer than one database operation can take (connect 2 s + query 5 s, edge-database.ts).
const ASSIGNMENT_CHECK_DEADLINE_MS = 8_000

type ControlAttachment = {
  k: 'control'
  // 'checking': the hello arrived and the assignment check is in flight. Its deadline closes
  // 4429 (transient), never 4401, so a slow database cannot look like a bad credential.
  phase: 'hello' | 'checking' | 'proof' | 'active'
  claims: EdgeClaims
  origin: string
  caps: string[]
  deadline: number
  challengeId?: string
  expectedProof?: string
  hello?: { previousGeneration?: number; controlResumeSecret?: string }
  // Decided at hello, as the cells do: it is part of the proof transcript.
  rebind?: boolean
  generation?: number
  lastPongAt?: number
  lastPingAt?: number
  leaseExpiresAt?: number
  // Client ingress '<continent>/<colo>', for metrics.
  place?: string
}
type Attachment = ControlAttachment
type Conn = {
  phase: 'pending' | 'active'
  generation: number
  connTicket?: string
  reservation: CredentialReservation
}

type Session = {
  generation: number
  resumeSecretHash: string
  userId: string
  profileId: string
  organizationId: string
  orphanedAt: number | null
  // The host's own close reason ('signed-out'), echoed on later phone 4404s, like the cells.
  closeReason?: { reason: string; expiresAt: number }
}

export type AuthorizeResult =
  | { ok: true; connTicket: string; generation: number }
  | { ok: false; code: number; reason?: string }
export type ConfirmResult = { ok: true; hello: RelayHello } | { ok: false; code: number }

const NO_DEADLINE = Number.MAX_SAFE_INTEGER
const SWEEP_AT_KEY = 'sweepAt'
// 6 h ± 30 min, as the cells: desktops re-ask the director at least this often.
const LEASE_BASE_MS = 6 * 60 * 60 * 1000
const LEASE_JITTER_MS = 30 * 60 * 1000
const GENERIC_REJECT_REASON = 'relay connection rejected'

export class HostRelay extends DurableObject<Env> {
  // A reset (code update past max_delay, runtime restart, eviction) drops sockets without close
  // events. A stored session with no live control is then treated as orphaned from this boot, so the
  // desktop can rebind within the grace and keep splices, which live in SpliceRelay objects.
  private readonly bootAt = Date.now()
  // Slots handed out recently whose phone hasn't authorized yet (in memory; a hint only).
  private recentPicks: { slot: number; at: number }[] = []
  private backendCache: EdgeBackend | null = null

  private get config(): EdgeConfig {
    return edgeConfig(this.env)
  }

  private get backend(): EdgeBackend {
    this.backendCache ??= edgeBackend(this.env, this.config.backend === 'object' ? { database: this.store.database, assignments: this.store } : undefined)
    return this.backendCache
  }

  // Phase 2: this host's credential tables and pushed assignment, in the object's own SQLite.
  private storeCache: ObjectStore | null = null
  private get store(): ObjectStore {
    this.storeCache ??= new ObjectStore(this.ctx.storage.sql, (operation) => this.ctx.storage.transaction(() => operation()), this.config.cellId)
    return this.storeCache
  }

  // ---------------- director admin (phase 2; the Worker verified the signed request) ----------------

  async adminAssign(body: AssignBody): Promise<AssignResult> {
    const result = await this.store.applyAssignment(body)
    if (result.outcome === 'applied' && body.cellId !== this.config.cellId) {
      // Moved away: like an old cell, send the desktop and its phones back to the director.
      for (const ws of this.ctx.getWebSockets('control')) this.close(ws, RELAY_CLOSE_CODE.WRONG_CELL, 'host moved')
      await this.closeSplices(() => true, RELAY_CLOSE_CODE.WRONG_CELL, 'host moved')
    }
    // Arms the daily sweep for objects that have not been woken since it existed.
    await this.reschedule()
    return result
  }

  // The director's move away: refused while the desktop is connected (it alone can change
  // devices); otherwise the host is frozen (hello and phones get WRONG_CELL) and snapshotted.
  async adminExport(): Promise<
    { outcome: 'busy' } | { outcome: 'exported'; assignment: StoredAssignment | null; devices: DeviceRow[] }
  > {
    if (this.ctx.getWebSockets('control').length > 0) return { outcome: 'busy' }
    const devices = this.store.freezeForExport()
    await this.closeSplices(() => true, RELAY_CLOSE_CODE.WRONG_CELL, 'host moving')
    await this.reschedule()
    return { outcome: 'exported', assignment: this.store.assignment(), devices }
  }

  // Erasure: refused while the host is live, as today's guard; otherwise every byte of the object goes.
  async adminErase(userId: string): Promise<{ outcome: 'erased' | 'busy' | 'mismatch' }> {
    const assignment = this.store.assignment()
    // Another account now holds this machine's object; its move on wiped the earlier account's data.
    if (assignment && assignment.userId !== userId) return { outcome: 'mismatch' }
    if (this.ctx.getWebSockets('control').length > 0 || this.store.activeBases() > 0) return { outcome: 'busy' }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.storeCache = null
    this.backendCache = null
    return { outcome: 'erased' }
  }

  async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get('x-edge-kind')
    if (kind === 'abort' && this.env.SPIKE_ADMIN === '1') {
      this.ctx.abort('spike reset')
    }
    if (kind === 'info' && this.env.SPIKE_DEBUG === '1') {
      const session = await this.ctx.storage.get<Session>('session')
      return Response.json({
        version: this.env.EDGE_VERSION ?? 'dev',
        generation: session?.generation ?? null,
        controls: this.ctx.getWebSockets('control').length,
        conns: Object.keys(await this.conns()).length
      })
    }
    if (kind !== 'control') return new Response(null, { status: 404 })
    const origin = request.headers.get('x-edge-origin') ?? ''
    const claims = JSON.parse(request.headers.get('x-edge-claims') ?? 'null') as EdgeClaims
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, ['control'])
    this.attach(server, {
      k: 'control',
      place: request.headers.get('x-edge-place') ?? undefined,
      phase: 'hello',
      claims,
      origin,
      caps: [...parseRelayHostCapabilities(request.headers.get('x-orca-host-capabilities') ?? '')],
      deadline: Date.now() + RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs
    })
    await this.reschedule()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.attachment(ws)
    if (!a) return
    return this.onControl(ws, a, message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.onSocketGone(ws, code, reason)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws, 1006, '')
  }

  // ---------------- control ----------------

  private async onControl(ws: WebSocket, a: ControlAttachment, message: string | ArrayBuffer): Promise<void> {
    if (frameOver(message, CONTROL_MAX_FRAME_BYTES)) {
      this.close(ws, MESSAGE_TOO_BIG, 'frame too large')
      return
    }
    if (typeof message !== 'string') {
      if (a.phase !== 'active') this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'binary hello')
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(message) as Record<string, unknown>
    } catch {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid control JSON')
      return
    }
    const { type, ...body } = parsed
    if (a.phase === 'hello') return this.onHostHello(ws, a, type, body)
    // The client waits for the challenge; nothing else is valid until then.
    if (a.phase === 'checking') return
    if (a.phase === 'proof') return this.onHostProof(ws, a, type, body)
    if (type === 'pong') {
      a.lastPongAt = Date.now()
      if (typeof body.t === 'number') metric(this.env, 'pong_rtt_ms', a.lastPongAt - body.t, '', [], '', a.place)
      this.attach(ws, a)
      return
    }
    if (type === 'auth-refresh') return this.onAuthRefresh(ws, body)
    return this.onCommand(ws, a, type, body)
  }

  private async onAuthRefresh(ws: WebSocket, body: Record<string, unknown>): Promise<void> {
    const parsed = AuthRefreshSchema.safeParse(body)
    if (!parsed.success) return
    const claims = await verifyRelayJwt(this.env, parsed.data.relayJwt)
    // Re-read after the await: the attachment may have moved on (pongs, pings) meanwhile.
    const current = this.attachment(ws)
    if (!current || current.k !== 'control') return
    const same =
      claims &&
      claims.userId === current.claims.userId &&
      claims.profileId === current.claims.profileId &&
      claims.organizationId === current.claims.organizationId &&
      claims.relayHostId === current.claims.relayHostId
    if (!same) {
      this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'refresh identity changed')
      return
    }
    if (claims.exp > current.claims.exp) current.claims = claims
    this.attach(ws, current)
    await this.reschedule()
  }

  // Host credential commands: same messages and error codes as the cells
  // (host-session-registry acceptControlCommandUnfenced), through the shared credential store.
  // Edge hosts write no activity leases (design: R10); bases and token expiry cover erasure.
  private async onCommand(ws: WebSocket, a: ControlAttachment, type: unknown, body: Record<string, unknown>): Promise<void> {
    if (typeof type !== 'string') return
    const identity = { userId: a.claims.userId, relayHostId: a.claims.relayHostId }
    const generation = a.generation ?? 0
    try {
      if (type === 'invite-create') {
        if (!this.authActive(a)) throw new Error('authorization_expired')
        const request = InviteCreateSchema.parse(body)
        const invite = await this.backend.createInvite(identity, request.relayDeviceId)
        this.send(ws, { type: 'invite-created', reqId: request.reqId, ...invite })
        return
      }
      if (type === 'device-credential-install') {
        const request = DeviceCredentialInstallSchema.parse(body)
        if (!this.authActive(a) && request.authorization.mode === 'authenticated-direct') {
          throw new Error('authorization_expired')
        }
        if (request.authorization.mode === 'authenticated-direct') {
          await this.backend.recordDirectAuthorization({
            ...identity,
            relayDeviceId: request.relayDeviceId,
            directAuthId: request.authorization.directAuthId,
            owningControlGeneration: generation,
            deadline: Date.now() + RELAY_PROTOCOL_LIMITS.resumeConfirmationDeadlineMs
          })
        }
        const result = await this.backend.installCredential({ ...identity, ...request, owningControlGeneration: generation })
        this.send(ws, { type: 'device-credential-installed', ...result })
        return
      }
      if (type === 'device-credential-install-status') {
        const request = DeviceCredentialInstallStatusSchema.parse(body)
        const result = await this.backend.installStatus({ ...identity, ...request })
        this.send(ws, {
          type: 'device-credential-install-status-result',
          v: 1,
          reqId: request.reqId,
          state: result ? 'committed' : 'not-found',
          ...(result ? { result } : {})
        })
        return
      }
      if (type === 'device-resume-confirm') {
        const request = DeviceResumeConfirmSchema.parse(body)
        const result = await this.backend.confirmResume({ ...identity, ...request, owningControlGeneration: generation })
        this.send(ws, { type: 'device-resume-confirmed', ...result })
        return
      }
      if (type === 'device-revoke') {
        const request = DeviceRevokeSchema.parse(body)
        await this.backend.revoke(identity, request.relayDeviceId)
        this.send(ws, { type: 'device-revoked', reqId: request.reqId })
        return
      }
      this.send(ws, { type: 'control-error', code: 'unknown_control_message' })
    } catch (error) {
      const reqId = typeof body.reqId === 'string' ? body.reqId : undefined
      this.send(ws, { type: 'control-error', ...(reqId ? { reqId } : {}), code: controlErrorCode(error) })
    }
  }

  // Active until the relay token expires; after that the seat only drains (cells: drain-only).
  private authActive(a: ControlAttachment, now = Date.now()): boolean {
    return a.phase === 'active' && now <= a.claims.exp
  }

  private async onHostHello(ws: WebSocket, a: ControlAttachment, type: unknown, body: Record<string, unknown>): Promise<void> {
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
    // The first frame arrived in time: from here a slow check is the relay's problem (4429).
    a.phase = 'checking'
    a.deadline = Date.now() + ASSIGNMENT_CHECK_DEADLINE_MS
    this.attach(ws, a)
    // The director's assignment row must place this host on the edge at the epoch the desktop was
    // given, as a cell checks its own id. A database failure is transient (4429), never a 4409.
    let assignmentValid: boolean
    try {
      assignmentValid = await this.backend.verifyAssignment(a.claims.userId, a.claims.relayHostId, hello.data.assignmentEpoch)
    } catch {
      this.close(ws, RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'relay temporarily unavailable')
      return
    }
    if (!assignmentValid) {
      this.close(ws, RELAY_CLOSE_CODE.WRONG_CELL, 'wrong assignment epoch')
      return
    }
    const current = this.attachment(ws)
    if (!current || current.k !== 'control' || current.phase !== 'checking') return
    const rebind = await this.canRebind(ws, current.claims, hello.data.previousGeneration, hello.data.controlResumeSecret)
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 10_000
    const ephemeral = nacl.box.keyPair()
    const nonce = nacl.randomBytes(24)
    const challengeId = crypto.randomUUID()
    const secret = nacl.randomBytes(32)
    const transcript = buildHostProofTranscript({
      relayOrigin: current.origin,
      relayEphemeralPublicKey: ephemeral.publicKey,
      challengeNonce: nonce,
      challengeId,
      issuedAt,
      expiresAt,
      userId: current.claims.userId,
      profileId: current.claims.profileId,
      organizationId: current.claims.organizationId,
      relayHostId: current.claims.relayHostId,
      hostPublicKey,
      assignmentEpoch: hello.data.assignmentEpoch,
      previousGeneration: hello.data.previousGeneration,
      resumeRequested: rebind
    })
    const ciphertext = nacl.box(buildHostChallengePlaintext(transcript, secret), nonce, hostPublicKey, ephemeral.secretKey)
    current.phase = 'proof'
    current.deadline = expiresAt
    current.challengeId = challengeId
    current.expectedProof = b64(await hmacSha256(secret, buildHostProofMacInput(transcript)))
    current.hello = {
      previousGeneration: hello.data.previousGeneration,
      controlResumeSecret: hello.data.controlResumeSecret
    }
    current.rebind = rebind
    this.attach(ws, current)
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

  // Rebind keeps the generation (and the host's splices): the secret matches, the stored session is
  // active or orphaned within its grace, and the identity is unchanged.
  private async canRebind(
    ws: WebSocket,
    claims: EdgeClaims,
    previousGeneration: number | undefined,
    secret: string | undefined
  ): Promise<boolean> {
    if (secret === undefined) return false
    const stored = await this.ctx.storage.get<Session>('session')
    if (!stored) return false
    const now = Date.now()
    const withinGrace =
      this.otherActiveControls(ws).length > 0 ||
      (stored.orphanedAt !== null && now - stored.orphanedAt <= this.config.orphanGraceMs) ||
      (stored.orphanedAt === null && now - this.bootAt <= this.config.orphanGraceMs)
    return (
      withinGrace &&
      stored.userId === claims.userId &&
      stored.profileId === claims.profileId &&
      stored.organizationId === claims.organizationId &&
      previousGeneration === stored.generation &&
      timingSafeEqualStr(await sha256B64url(new TextEncoder().encode(secret)), stored.resumeSecretHash)
    )
  }

  private otherActiveControls(ws: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets('control').filter((s) => s !== ws && this.attachment(s)?.phase === 'active')
  }

  private async onHostProof(ws: WebSocket, a: ControlAttachment, type: unknown, body: Record<string, unknown>): Promise<void> {
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
    const otherControls = this.otherActiveControls(ws)
    // Re-check: the session may have moved on (another control, or the grace ran out) since hello.
    const rebind =
      a.rebind === true &&
      stored !== undefined &&
      (await this.canRebind(ws, a.claims, a.hello?.previousGeneration, a.hello?.controlResumeSecret))

    let generation: number
    let resumeSecret: string
    if (rebind) {
      generation = stored!.generation
      resumeSecret = a.hello!.controlResumeSecret!
      for (const old of otherControls) this.close(old, RELAY_CLOSE_CODE.PEER_DROPPED, 'control rebound')
    } else {
      generation = (stored?.generation ?? 0) + 1
      resumeSecret = b64url(nacl.randomBytes(32))
      for (const old of otherControls) this.close(old, RELAY_CLOSE_CODE.PEER_DROPPED, 'replaced by a newer generation')
      await this.closeSplices(() => true, RELAY_CLOSE_CODE.PEER_DROPPED, 'host control replaced')
    }
    // A new control replaces whatever the last one said on its way out.
    await this.ctx.storage.put<Session>('session', {
      generation,
      resumeSecretHash: await sha256B64url(new TextEncoder().encode(resumeSecret)),
      userId: a.claims.userId,
      profileId: a.claims.profileId,
      organizationId: a.claims.organizationId,
      orphanedAt: null
    })
    const leaseExpiresAt = now + LEASE_BASE_MS + Math.round((Math.random() * 2 - 1) * LEASE_JITTER_MS)
    a.phase = 'active'
    a.generation = generation
    a.lastPongAt = now
    a.lastPingAt = now
    a.leaseExpiresAt = leaseExpiresAt
    a.deadline = NO_DEADLINE
    delete a.expectedProof
    delete a.hello
    delete a.rebind
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
          ...(details ? { kind: c.reservation.credentialKind, relayDeviceId: c.reservation.relayDeviceId } : {})
        })
      }
    }
    this.send(ws, {
      type: 'host-hello-ack',
      v: 1,
      generation,
      controlResumeSecret: resumeSecret,
      leaseExpiresAt,
      activeConnIds: activeConnIds.slice(0, 8),
      pendingConns: pendingConns.slice(0, 8)
    })
    metric(this.env, 'control_active', 1, rebind ? 'rebind' : 'new', [], '', a.place)
    await this.reschedule()
  }

  private activeControl(): { ws: WebSocket; a: ControlAttachment } | null {
    for (const ws of this.ctx.getWebSockets('control')) {
      const a = this.attachment(ws)
      if (a?.k === 'control' && a.phase === 'active') return { ws, a }
    }
    return null
  }

  // ---------------- RPC from the Worker ----------------

  // Picks the least-busy slot of this host's splice pool for a new phone connection, so concurrent
  // phones land in different objects. Ties go to a random slot. Not a reservation: a slot can still
  // hold several splices, and the 8-connection budget is enforced in authorizePhone.
  // Object backend: null for a host the director has not pushed (never, or wiped since), so the
  // Worker answers the phone without this object or a splice object writing any storage.
  async allocateConnId(relayHostId: string): Promise<string | null> {
    if (this.config.backend === 'object' && !this.pushed()) return null
    const now = Date.now()
    this.recentPicks = this.recentPicks.filter((p) => now - p.at < 15_000)
    const load = new Array<number>(SPLICE_SLOTS).fill(0)
    for (const connId of Object.keys(await this.conns())) {
      const parsed = parseConnId(connId)
      if (parsed) load[parsed.slot]++
    }
    for (const p of this.recentPicks) load[p.slot]++
    const min = Math.min(...load)
    const candidates = load.flatMap((n, slot) => (n === min ? [slot] : []))
    const slot = candidates[Math.floor(Math.random() * candidates.length)]
    this.recentPicks.push({ slot, at: now })
    return makeConnId(relayHostId, slot)
  }

  // Read-only: an object nobody pushed has no tables, and this must not create them.
  private pushed(): boolean {
    const sql = this.ctx.storage.sql
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edge_assignment'").toArray().length === 0) return false
    return sql.exec('SELECT 1 FROM edge_assignment WHERE id = 1').toArray().length > 0
  }

  // ---------------- RPC from SpliceRelay ----------------

  // Phone presented relay-auth to its splice object. Same order and answers as a cell
  // (host-session-registry acceptClient): one device read for a resume token, else the invite/
  // reservation path; a refused token is 4401; a missing seat is 4409 when the assignment names
  // another cell, else 4404; a full host is 4429. Database failures answer 4503, never 4401.
  async authorizePhone(connId: string, credentialToken: string): Promise<AuthorizeResult> {
    const hostId = parseConnId(connId)?.relayHostId
    if (!hostId) return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL }
    let reservation: CredentialReservation | null
    try {
      const found = await this.backend.lookupResume(hostId, credentialToken)
      if (found.outcome === 'refused') return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL }
      reservation =
        found.outcome === 'resume' ? found.reservation : await this.backend.reserveCredential(hostId, credentialToken)
    } catch {
      return { ok: false, code: RELAY_CLOSE_CODE.DRAINING }
    }
    if (!reservation) return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL }
    const control = this.activeControl()
    const seated =
      control !== null &&
      control.a.generation !== undefined &&
      this.authActive(control.a) &&
      // The spike backend has no user binding; the database path must match the seated user.
      (reservation.userId === '' || reservation.userId === control.a.claims.userId)
    if (!seated || !control) {
      await this.backend.failReservation(reservation).catch(() => {})
      return this.missedSeat(reservation)
    }
    const conns = await this.conns()
    if (Object.keys(conns).length >= RELAY_PROTOCOL_LIMITS.maxConnectionsPerHost) {
      await this.pruneDeadConns(conns)
      if (Object.keys(conns).length >= RELAY_PROTOCOL_LIMITS.maxConnectionsPerHost) {
        await this.backend.failReservation(reservation).catch(() => {})
        return { ok: false, code: RELAY_CLOSE_CODE.LIMIT_EXCEEDED }
      }
    }
    const picked = parseConnId(connId)
    const pickIndex = this.recentPicks.findIndex((p) => p.slot === picked?.slot)
    if (pickIndex >= 0) this.recentPicks.splice(pickIndex, 1)
    const connTicket = b64url(nacl.randomBytes(32))
    const generation = control.a.generation!
    conns[connId] = { phase: 'pending', generation, connTicket, reservation }
    await this.ctx.storage.put('conns', conns)
    this.send(control.ws, {
      type: 'conn-open',
      connId,
      connTicket,
      kind: reservation.credentialKind,
      relayDeviceId: reservation.relayDeviceId,
      attachDeadlineMs: RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs
    })
    return { ok: true, connTicket, generation }
  }

  private async missedSeat(reservation: CredentialReservation): Promise<AuthorizeResult> {
    let elsewhere: boolean
    try {
      elsewhere = await this.backend.assignedElsewhere(reservation.userId, reservation.relayHostId)
    } catch {
      // As the cells: an unreadable row sends the phone to its director rather than pinning it.
      elsewhere = true
    }
    if (elsewhere) return { ok: false, code: RELAY_CLOSE_CODE.WRONG_CELL }
    const session = await this.ctx.storage.get<Session>('session')
    const remembered =
      session?.closeReason && session.closeReason.expiresAt > Date.now() ? session.closeReason.reason : undefined
    return { ok: false, code: RELAY_CLOSE_CODE.HOST_OFFLINE, reason: remembered ?? GENERIC_REJECT_REASON }
  }

  // Host data socket presented a valid ticket to the splice object. Persists the connection basis
  // (what device-resume-confirm and install read later), then answers the phone's relay-hello.
  async confirmSplice(connId: string, generation: number): Promise<ConfirmResult> {
    const conns = await this.conns()
    const conn = conns[connId]
    if (!conn || conn.phase !== 'pending' || conn.generation !== generation) {
      return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL }
    }
    if (this.activeControl()?.a.generation !== generation) {
      return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL }
    }
    const r = conn.reservation
    const deadline =
      r.credentialKind === 'resume' ? Date.now() + RELAY_PROTOCOL_LIMITS.resumeConfirmationDeadlineMs : r.leaseExpiresAt
    try {
      await this.backend.recordConnectionBasis({ ...r, basisConnId: connId, owningControlGeneration: generation, deadline })
    } catch {
      delete conns[connId]
      await this.ctx.storage.put('conns', conns)
      await this.backend.failReservation(r).catch(() => {})
      return { ok: false, code: RELAY_CLOSE_CODE.LIMIT_EXCEEDED }
    }
    conns[connId] = { ...conn, phase: 'active', connTicket: undefined }
    await this.ctx.storage.put('conns', conns)
    const hello: RelayHello =
      r.credentialKind === 'resume'
        ? {
            ok: true,
            credentialKind: 'resume',
            leaseExpiresAt: r.leaseExpiresAt,
            acceptedCredentialVersion: r.acceptedCredentialVersion!,
            acceptedAs: r.acceptedAs!,
            resumeExpiresAt: r.resumeExpiresAt!,
            ...(r.graceExpiresAt === undefined ? {} : { graceExpiresAt: r.graceExpiresAt })
          }
        : { ok: true, credentialKind: 'invite', leaseExpiresAt: r.leaseExpiresAt }
    return { ok: true, hello }
  }

  async spliceClosed(connId: string): Promise<void> {
    const conns = await this.conns()
    const conn = conns[connId]
    if (!conn) return
    delete conns[connId]
    await this.ctx.storage.put('conns', conns)
    await this.releaseConn(connId, conn)
  }

  // Best effort, as the cells: a pending phone's invite reservation goes back (cooldown), an
  // attached one's basis is deactivated; credential cleanup on the directors covers misses.
  private async releaseConn(connId: string, conn: Conn): Promise<void> {
    if (conn.phase === 'pending') await this.backend.failReservation(conn.reservation).catch(() => {})
    else await this.backend.deactivateBasis(connId).catch(() => {})
  }

  private async conns(): Promise<Record<string, Conn>> {
    return (await this.ctx.storage.get<Record<string, Conn>>('conns')) ?? {}
  }

  // A splice object that was reset never reports its close. Ask before refusing on the budget.
  private async pruneDeadConns(conns: Record<string, Conn>): Promise<void> {
    const ids = Object.keys(conns)
    const alive = await Promise.all(ids.map((id) => this.splice(id).isAlive(id).catch(() => false)))
    const dead: [string, Conn][] = []
    ids.forEach((id, i) => {
      if (!alive[i]) {
        dead.push([id, conns[id]])
        delete conns[id]
      }
    })
    await this.ctx.storage.put('conns', conns)
    await Promise.all(dead.map(([id, conn]) => this.releaseConn(id, conn)))
  }

  private splice(connId: string) {
    const object = parseConnId(connId)?.object ?? connId
    return this.env.SPLICE_RELAY.get(this.env.SPLICE_RELAY.idFromName(object))
  }

  private async closeSplices(filter: (c: Conn) => boolean, code: number, reason: string): Promise<void> {
    const conns = await this.conns()
    const ids = Object.keys(conns).filter((id) => filter(conns[id]))
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => this.splice(id).closeSplice(id, code, reason).catch(() => {})))
    const closed = ids.map((id) => [id, conns[id]] as const)
    for (const id of ids) delete conns[id]
    await this.ctx.storage.put('conns', conns)
    await Promise.all(closed.map(([id, conn]) => this.releaseConn(id, conn)))
  }

  // ---------------- lifecycle ----------------

  private async onSocketGone(ws: WebSocket, code: number, reason: string): Promise<void> {
    const a = this.attachment(ws)
    if (!a) return
    // During webSocketClose the closing socket is still listed; clear it first so it can't count as live.
    this.attach(ws, null)
    if (a.k === 'control' && a.phase === 'active') metric(this.env, 'control_close', 1, String(code), [], '', a.place)
    if (a.k === 'control' && a.phase === 'active' && !this.activeControl()) {
      const session = await this.ctx.storage.get<Session>('session')
      if (session && session.generation === a.generation) {
        const hostReason = relayHostCloseReasonFrom(reason)
        await this.ctx.storage.put<Session>('session', {
          ...session,
          orphanedAt: Date.now(),
          ...(hostReason ? { closeReason: { reason: hostReason, expiresAt: Date.now() + ASSIGNMENT_LIMITS.dormantTtlMs } } : {})
        })
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
        if (now - (a.lastPongAt ?? now) > this.config.silenceTimeoutMs) {
          this.close(ws, RELAY_CLOSE_CODE.PEER_DROPPED, 'control silence timeout')
          await this.onSocketGone(ws, RELAY_CLOSE_CODE.PEER_DROPPED, '')
          continue
        }
        // Same order as the cells' heartbeat: expired auth past its grace, then the 6 h lease.
        if (now > a.claims.exp + CONTROL_CONTINUITY_LIMITS.expiredAuthExistingSpliceGraceMs) {
          this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'relay authorization expired')
          await this.onSocketGone(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, '')
          continue
        }
        if (a.leaseExpiresAt !== undefined && now > a.leaseExpiresAt) {
          this.send(ws, { type: 'drain', graceMs: 0, recovery: 'resolve-director' })
          this.close(ws, RELAY_CLOSE_CODE.DRAINING, 'control lease expired')
          await this.onSocketGone(ws, RELAY_CLOSE_CODE.DRAINING, '')
          continue
        }
        if (now - (a.lastPingAt ?? 0) >= this.config.pingIntervalMs - 50) {
          if (a.lastPingAt) metric(this.env, 'alarm_lag_ms', Math.max(0, now - (a.lastPingAt + this.config.pingIntervalMs)), '', [], '', a.place)
          this.send(ws, { type: 'ping', t: now })
          a.lastPingAt = now
          this.attach(ws, a)
        }
        continue
      }
      if (now >= a.deadline) {
        if (a.phase === 'checking') this.close(ws, RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'relay temporarily unavailable')
        else this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, a.phase === 'proof' ? 'invalid host proof' : 'first frame timeout')
        await this.onSocketGone(ws, 1006, '')
      }
    }
    const session = await this.ctx.storage.get<Session>('session')
    if (session?.orphanedAt != null && !this.activeControl() && now - session.orphanedAt >= this.config.orphanGraceMs) {
      await this.closeSplices(() => true, RELAY_CLOSE_CODE.PEER_DROPPED, 'host control lost')
      await this.ctx.storage.put<Session>('session', { ...session, orphanedAt: null })
    }
    if (this.config.backend === 'object') {
      const sweepAt = await this.ctx.storage.get<number>(SWEEP_AT_KEY)
      if (sweepAt !== undefined && sweepAt <= now && (await this.sweep(now)) === 'wiped') return
    }
    await this.reschedule()
  }

  // Daily, object backend: the credential store's own expiry cleanup (the cells run it from the
  // director), and a wipe of an object whose host never arrived or left more than the retention ago.
  private async sweep(now: number): Promise<'swept' | 'wiped'> {
    const assignment = this.store.assignment()
    const left =
      assignment === null ||
      (assignment.cellId !== this.config.cellId && now - (this.store.assignmentUpdatedAt() ?? now) >= this.config.leftRetentionMs)
    if (left && this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.storeCache = null
      this.backendCache = null
      metric(this.env, 'sweep', 1, 'wiped')
      return 'wiped'
    }
    await new RelayCredentialStore(this.store.database, () => now).cleanup()
    await this.ctx.storage.put(SWEEP_AT_KEY, now + this.config.sweepIntervalMs)
    metric(this.env, 'sweep', 1, 'swept')
    return 'swept'
  }

  private async reschedule(): Promise<void> {
    let next = NO_DEADLINE
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws)
      if (!a) continue
      if (a.k === 'control' && a.phase === 'active') {
        next = Math.min(
          next,
          (a.lastPingAt ?? 0) + this.config.pingIntervalMs,
          a.claims.exp + CONTROL_CONTINUITY_LIMITS.expiredAuthExistingSpliceGraceMs + 1,
          (a.leaseExpiresAt ?? NO_DEADLINE - 1) + 1
        )
      } else {
        next = Math.min(next, a.deadline)
      }
    }
    const session = await this.ctx.storage.get<Session>('session')
    if (session?.orphanedAt != null) next = Math.min(next, session.orphanedAt + this.config.orphanGraceMs)
    if (this.config.backend === 'object') {
      // The sweep keeps an alarm armed on every object with storage, so idle ones still get cleaned.
      let sweepAt = await this.ctx.storage.get<number>(SWEEP_AT_KEY)
      if (sweepAt === undefined) {
        sweepAt = Date.now() + this.config.sweepIntervalMs
        await this.ctx.storage.put(SWEEP_AT_KEY, sweepAt)
      }
      next = Math.min(next, sweepAt)
    }
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
    metric(this.env, 'refuse', 1, `control:${code}`, [], reason, this.attachment(ws)?.place)
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
