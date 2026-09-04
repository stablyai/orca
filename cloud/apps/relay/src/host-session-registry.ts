import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  ASSIGNMENT_LIMITS,
  AuthRefreshSchema,
  buildHostChallengePlaintext,
  buildHostProofMacInput,
  buildHostProofTranscript,
  CONTROL_CONTINUITY_LIMITS,
  DeviceCredentialInstallSchema,
  DeviceCredentialInstallStatusSchema,
  DeviceResumeConfirmSchema,
  DeviceRevokeSchema,
  HostChallengeAckSchema,
  HostHelloSchema,
  InviteCreateSchema,
  RELAY_PROTOCOL_LIMITS,
  RELAY_CLOSE_CODE
} from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
import type { RelayConfig } from './config.js'
import type { RelayAssignmentStore } from './assignment-store.js'
import {
  RelayCredentialStore,
  type CredentialReservation
} from './credential-store.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import type { RelayRuntimeObserver } from './relay-observability.js'
import type { PendingHostDataReservation } from './relay-connection-ledger.js'
import { closeRelayWebSocket } from './relay-websocket-close.js'
import { ProcessQueuedByteBudget, wireSplice } from './splice-forwarder.js'

// Peer-supplied close reasons are logged; keep them printable and short.
function printableCloseReason(reason: Buffer | string): string {
  return reason
    .toString()
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 80)
}

type VerifyRelayToken = (token: string) => Promise<RelayTokenClaims | null>
type HostState = 'proving' | 'active' | 'orphaned' | 'drain-only' | 'closed'

const CONTROL_ACTIVITY_RENEWAL_INTERVAL_MS = RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2
// Preserve the existing 75s renewal runway after doubling the successful-call interval.
const CONTROL_ACTIVITY_LEASE_MS =
  ASSIGNMENT_LIMITS.activityLeaseMs +
  CONTROL_ACTIVITY_RENEWAL_INTERVAL_MS -
  RELAY_PROTOCOL_LIMITS.controlPingIntervalMs

export type HostSession = {
  identity: RelayTokenClaims
  readonly relayHostId: string
  readonly generation: number
  readonly assignmentEpoch: number
  readonly controlActivityId: string | null
  readonly controlResumeSecret: string
  // Why: reconnect churn is only actionable once it can be pinned to a client build.
  // Refreshed on rebind so it describes the socket that closed, not the first one.
  appVersion: string
  state: HostState
  socket: WebSocket | null
  leaseExpiresAt: number
  orphanTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  lastPongAt: number
  activityRenewalDueAt: number
  activityRenewalAttempt: number
  activityRenewalCompletedAttempt: number
  activeConnIds: Set<string>
  activeSplices: Map<string, (code?: number, reason?: string) => void>
  pendingConns: Map<string, PendingConnection>
  // Why: relay-initiated teardown drains these maps before closing the control
  // socket, so the close handler would otherwise always report zero destroyed work.
  closingCounts: { splices: number; pending: number } | null
  regionalDrainAttemptId: string | null
  regionalDrainTimer: ReturnType<typeof setTimeout> | null
  regionalDrainExpiresAt: number | null
}

export type RegionalHostDrainOutcome =
  | 'accepted'
  | 'already-accepted'
  | 'host-not-connected'

type PendingConnection = {
  connId: string
  connTicket: string
  reservation: CredentialReservation
  client: WebSocket
  attachTimer: ReturnType<typeof setTimeout>
  credentialActivityId: string | null
  capacityReservation?: PendingHostDataReservation
}

function decodeCanonicalBase64(value: string, bytes: number): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === bytes && decoded.toString('base64') === value ? decoded : null
}

function relayHostId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
}

function payload(raw: RawData, expectedType: string): unknown {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return null
  try {
    const parsed = JSON.parse(raw.toString()) as Record<string, unknown>
    if (parsed.type !== expectedType) return null
    const { type: _type, ...rest } = parsed
    return rest
  } catch {
    return null
  }
}

function send(socket: WebSocket, type: string, message: object): void {
  socket.send(JSON.stringify({ type, ...message }))
}

// Hosts abandon connects after 15s; waiting much longer than that behind a
// stalled predecessor only accumulates doomed sockets.
const ACTIVATION_QUEUE_WAIT_MS = 30_000

export class HostSessionRegistry {
  private readonly sessions = new Map<string, HostSession>()
  private readonly activationQueues = new Map<string, Promise<void>>()
  private draining = false

  constructor(
    private readonly config: RelayConfig,
    private readonly verifyRelayToken: VerifyRelayToken,
    private readonly store: RelayCredentialStore,
    private readonly assignments: RelayAssignmentStore,
    private readonly queuedByteBudget: ProcessQueuedByteBudget,
    private readonly observer: RelayRuntimeObserver,
    private readonly now: () => number = Date.now
  ) {}

  async acceptClient(
    socket: WebSocket,
    hostId: string,
    credential: string,
    capacityReservation?: PendingHostDataReservation
  ): Promise<void> {
    if (this.draining) {
      capacityReservation?.release()
      this.rejectClient(socket, RELAY_CLOSE_CODE.DRAINING)
      return
    }
    if (this.config.role === 'cell') {
      const outerIdentity =
        (await this.store.resolveResume(hostId, credential)) ??
        (await this.store.resolveInviteForMove(hostId, credential))
      const assignment = outerIdentity
        ? await this.assignments.resolve({ userId: outerIdentity.userId, relayHostId: hostId })
        : null
      if (!assignment || assignment.cellId !== this.config.cellId) {
        capacityReservation?.release()
        this.observer.recordAuth(false)
        this.rejectClient(socket, RELAY_CLOSE_CODE.WRONG_CELL)
        return
      }
    }
    const reservation = await this.store.reserveCredential(hostId, credential)
    if (!reservation) {
      capacityReservation?.release()
      this.observer.recordAuth(false)
      this.rejectClient(socket, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
      return
    }
    this.observer.recordAuth(true)
    const session = this.sessions.get(this.key(reservation.userId, hostId))
    if (
      !session ||
      session.state !== 'active' ||
      !session.socket ||
      session.socket.readyState !== session.socket.OPEN
    ) {
      capacityReservation?.release()
      await this.store.failReservation(reservation)
      this.rejectClient(socket, RELAY_CLOSE_CODE.HOST_OFFLINE)
      return
    }
    if (session.activeConnIds.size + session.pendingConns.size >= 8) {
      capacityReservation?.release()
      await this.store.failReservation(reservation)
      this.rejectClient(socket, RELAY_CLOSE_CODE.LIMIT_EXCEEDED)
      return
    }
    const connId = randomUUID()
    const connTicket = randomBytes(32).toString('base64url')
    const identity = { userId: reservation.userId, relayHostId: hostId }
    const credentialActivityId =
      this.config.role === 'cell'
        ? `${reservation.credentialKind === 'invite' ? 'invite' : 'confirmation'}:${connId}`
        : null
    if (credentialActivityId) {
      try {
        await this.assignments.acquireActivity(identity, {
          activityId: credentialActivityId,
          kind: reservation.credentialKind === 'invite' ? 'invite' : 'confirmation',
          cellId: this.config.cellId
        })
      } catch {
        capacityReservation?.release()
        await this.store.failReservation(reservation)
        this.rejectClient(socket, RELAY_CLOSE_CODE.LIMIT_EXCEEDED)
        return
      }
    }
    const attachTimer = setTimeout(() => {
      session.pendingConns.delete(connId)
      capacityReservation?.release()
      this.failReservationBestEffort(reservation)
      if (credentialActivityId) this.releaseActivityBestEffort(identity, credentialActivityId)
      this.rejectClient(socket, RELAY_CLOSE_CODE.HOST_OFFLINE)
    }, RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs)
    const pending: PendingConnection = {
      connId,
      connTicket,
      reservation,
      client: socket,
      attachTimer,
      credentialActivityId,
      capacityReservation
    }
    capacityReservation?.bind(connId)
    session.pendingConns.set(connId, pending)
    send(session.socket, 'conn-open', {
      connId,
      connTicket,
      kind: reservation.credentialKind,
      relayDeviceId: reservation.relayDeviceId,
      attachDeadlineMs: RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs
    })
    socket.once('close', () => {
      const current = session.pendingConns.get(connId)
      if (current?.client === socket) {
        clearTimeout(current.attachTimer)
        session.pendingConns.delete(connId)
        current.capacityReservation?.release()
        this.failReservationBestEffort(current.reservation)
        if (current.credentialActivityId) {
          this.releaseActivityBestEffort(identity, current.credentialActivityId)
        }
      }
    })
  }

  async acceptHostData(
    socket: WebSocket,
    connId: string,
    connTicket: string,
    generation: number
  ): Promise<boolean> {
    const session = [...this.sessions.values()].find((candidate) =>
      candidate.pendingConns.has(connId)
    )
    const pending = session?.pendingConns.get(connId)
    if (
      !session ||
      !pending ||
      pending.connTicket !== connTicket ||
      session.generation !== generation ||
      (session.state !== 'active' && session.state !== 'drain-only')
    ) {
      this.observer.recordAuth(false)
      socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data ticket')
      return false
    }
    this.observer.recordAuth(true)
    clearTimeout(pending.attachTimer)
    session.pendingConns.delete(connId)
    session.activeConnIds.add(connId)
    const basisDeadline =
      pending.reservation.credentialKind === 'resume'
        ? this.now() + RELAY_PROTOCOL_LIMITS.resumeConfirmationDeadlineMs
        : pending.reservation.leaseExpiresAt
    const identity = {
      userId: pending.reservation.userId,
      relayHostId: pending.reservation.relayHostId
    }
    const spliceActivityId = this.config.role === 'cell' ? `splice:${connId}` : null
    try {
      if (spliceActivityId) {
        await this.assignments.acquireActivity(identity, {
          activityId: spliceActivityId,
          kind: 'splice',
          cellId: this.config.cellId
        })
      }
      await this.store.recordConnectionBasis({
        ...pending.reservation,
        basisConnId: connId,
        owningControlGeneration: session.generation,
        deadline: basisDeadline
      })
    } catch {
      session.activeConnIds.delete(connId)
      await this.store.failReservation(pending.reservation)
      if (spliceActivityId) this.releaseActivityBestEffort(identity, spliceActivityId)
      if (pending.credentialActivityId) {
        this.releaseActivityBestEffort(identity, pending.credentialActivityId)
      }
      this.rejectClient(pending.client, RELAY_CLOSE_CODE.LIMIT_EXCEEDED)
      socket.close(RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'basis persistence failed')
      return false
    }
    const close = wireSplice({
      client: pending.client,
      host: socket,
      budget: this.queuedByteBudget,
      onClose: () => {
        session.activeConnIds.delete(connId)
        session.activeSplices.delete(connId)
        this.deactivateBasisBestEffort(connId)
        if (spliceActivityId) this.releaseActivityBestEffort(identity, spliceActivityId)
        if (pending.credentialActivityId) {
          this.releaseActivityBestEffort(identity, pending.credentialActivityId)
        }
      },
      onForwardedBytes: (bytes) => this.observer.recordForwardedBytes(bytes),
      onClosed: (closeInfo) => {
        this.observer.recordSpliceClose?.(closeInfo.trigger)
        // Only abnormal closes are logged; routine peer disconnects would be
        // one line per phone backgrounding.
        if (
          closeInfo.code === RELAY_CLOSE_CODE.LIMIT_EXCEEDED ||
          closeInfo.trigger.includes('error') ||
          closeInfo.trigger.includes('oversize')
        ) {
          console.warn(
            `[orca-relay] splice closed host=${relayHostLogDigest(session.relayHostId)}` +
              ` trigger=${closeInfo.trigger} code=${closeInfo.code}` +
              ` reason=${JSON.stringify(closeInfo.reason)}`
          )
        }
      }
    })
    session.activeSplices.set(connId, close)
    if (pending.client.readyState !== pending.client.OPEN || socket.readyState !== socket.OPEN) {
      close()
      return false
    }
    send(pending.client, 'relay-hello', {
      ok: true,
      credentialKind: pending.reservation.credentialKind,
      leaseExpiresAt: pending.reservation.leaseExpiresAt,
      ...(pending.reservation.credentialKind === 'resume'
        ? {
            acceptedCredentialVersion: pending.reservation.acceptedCredentialVersion,
            acceptedAs: pending.reservation.acceptedAs,
            resumeExpiresAt: pending.reservation.resumeExpiresAt,
            ...(pending.reservation.graceExpiresAt === undefined
              ? {}
              : { graceExpiresAt: pending.reservation.graceExpiresAt })
          }
        : {})
    })
    return true
  }

  acceptControl(
    socket: WebSocket,
    identity: RelayTokenClaims,
    connectionInclusionWatermark?: number
  ): void {
    if (this.draining) {
      socket.close(RELAY_CLOSE_CODE.DRAINING, 'relay draining')
      return
    }
    let firstFrameTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'host hello timeout')
    }, 2_000)
    socket.once('message', (raw, isBinary) => {
      if (firstFrameTimer) clearTimeout(firstFrameTimer)
      firstFrameTimer = null
      if (isBinary) {
        socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'host hello must be text')
        return
      }
      this.guardSessionTask(
        () =>
          this.beginProof(
            socket,
            identity,
            payload(raw, 'host-hello'),
            connectionInclusionWatermark
          ),
        socket,
        'host hello proof'
      )
    })
  }

  // A dependency failure (e.g. a database connect timeout) must cost one
  // handshake or command, not the process: an unhandled rejection here has
  // crashed whole cells and wiped their in-memory draining flag. 4429 is the
  // endpoint-scoped close in the contract, so the client retries this cell.
  private guardSessionTask(
    task: () => Promise<void>,
    socket: WebSocket | null,
    context: string
  ): void {
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        const message = (error instanceof Error ? error.message : 'unknown')
          // Untruncated, unlike peer-supplied close reasons: this is the
          // primary diagnostic for the next rejection class.
          .replace(/[^\x20-\x7e]/g, '')
        console.warn(`[orca-relay] ${context} failed: ${message}`)
        socket?.close(RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'relay temporarily unavailable')
      })
      // Terminal: a throw in the handler above must not itself crash the process.
      .catch(() => {})
  }

  get(identity: RelayIdentityKey): HostSession | null {
    return this.sessions.get(this.key(identity.userId, identity.relayHostId)) ?? null
  }

  hasActiveControl(identity: RelayIdentityKey): boolean {
    const session = this.get(identity)
    return (
      session !== null &&
      session.state === 'active' &&
      session.socket !== null &&
      session.socket.readyState === session.socket.OPEN
    )
  }

  runtimeCounts(): { controls: number; splices: number; pendingSplices: number } {
    let controls = 0
    let splices = 0
    let pendingSplices = 0
    for (const session of this.sessions.values()) {
      const socket = session.socket
      if (
        socket !== null &&
        socket.readyState === socket.OPEN &&
        (session.state === 'active' || session.state === 'drain-only')
      ) {
        controls++
      }
      splices += session.activeSplices.size
      pendingSplices += session.pendingConns.size
    }
    return { controls, splices, pendingSplices }
  }

  drain(graceMs: number): void {
    this.draining = true
    for (const session of this.sessions.values()) {
      if (session.state === 'closed') continue
      session.state = 'drain-only'
      if (session.socket) send(session.socket, 'drain', { graceMs, recovery: 'resolve-director' })
      setTimeout(() => this.closeDrainedSession(session), graceMs)
    }
  }

  drainHost(input: {
    attemptId: string
    userId: string
    relayHostId: string
    sourceAssignmentEpoch: number
    graceMs: number
  }): RegionalHostDrainOutcome {
    const session = this.get(input)
    if (!session || session.state === 'closed') return 'host-not-connected'
    if (session.assignmentEpoch !== input.sourceAssignmentEpoch) {
      throw new Error('regional_rehome_assignment_epoch_mismatch')
    }
    if (session.regionalDrainAttemptId) {
      if (session.regionalDrainAttemptId !== input.attemptId) {
        throw new Error('regional_rehome_attempt_conflict')
      }
      this.reassertRegionalDrain(session)
      return 'already-accepted'
    }
    session.regionalDrainAttemptId = input.attemptId
    session.regionalDrainExpiresAt = this.now() + input.graceMs
    this.reassertRegionalDrain(session)
    session.regionalDrainTimer = setTimeout(
      () => this.closeDrainedSession(session),
      input.graceMs
    )
    return 'accepted'
  }

  isDraining(): boolean {
    return this.draining
  }

  private async beginProof(
    socket: WebSocket,
    identity: RelayTokenClaims,
    candidate: unknown,
    connectionInclusionWatermark?: number
  ): Promise<void> {
    const hello = HostHelloSchema.safeParse(candidate)
    const hostPublicKey = hello.success
      ? decodeCanonicalBase64(hello.data.hostPublicKeyB64, 32)
      : null
    if (!hello.success) {
      this.observer.recordAuth(false)
      socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host hello')
      return
    }
    if (!hostPublicKey) {
      this.observer.recordAuth(false)
      socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host public key')
      return
    }
    if (
      hello.data.relayHostId !== identity.relayHostId ||
      relayHostId(hostPublicKey) !== identity.relayHostId
    ) {
      this.observer.recordAuth(false)
      socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'host key binding mismatch')
      return
    }
    // Combined is staging-only compatibility; stamped cells require the durable director epoch.
    const assignmentValid =
      this.config.role === 'combined'
        ? hello.data.assignmentEpoch === 1
        : await this.assignments.verifyCellAssignment({
            userId: identity.sub,
            relayHostId: identity.relayHostId,
            cellId: this.config.cellId,
            assignmentEpoch: hello.data.assignmentEpoch
          })
    if (!assignmentValid) {
      this.observer.recordAuth(false)
      socket.close(RELAY_CLOSE_CODE.WRONG_CELL, 'wrong assignment epoch')
      return
    }

    const key = this.key(identity.sub, identity.relayHostId)
    const existing = this.sessions.get(key)
    const rebind = Boolean(
      existing &&
        hello.data.controlResumeSecret &&
        hello.data.controlResumeSecret === existing.controlResumeSecret &&
        (existing.state === 'orphaned' || existing.state === 'active')
    )
    const generation = rebind ? existing!.generation : (existing?.generation ?? 0) + 1
    const ephemeral = nacl.box.keyPair()
    const challengeNonce = randomBytes(nacl.box.nonceLength)
    const challengeSecret = randomBytes(32)
    const challengeId = randomUUID()
    const issuedAt = this.now()
    const expiresAt = issuedAt + 10_000
    const transcript = buildHostProofTranscript({
      relayOrigin: this.config.publicUrl,
      relayEphemeralPublicKey: ephemeral.publicKey,
      challengeNonce,
      challengeId,
      issuedAt,
      expiresAt,
      userId: identity.sub,
      profileId: identity.prof,
      organizationId: identity.org ?? '',
      relayHostId: identity.relayHostId,
      hostPublicKey,
      assignmentEpoch: hello.data.assignmentEpoch,
      previousGeneration: hello.data.previousGeneration,
      resumeRequested: rebind
    })
    const plaintext = buildHostChallengePlaintext(transcript, challengeSecret)
    const ciphertext = nacl.box(plaintext, challengeNonce, hostPublicKey, ephemeral.secretKey)
    const expectedProof = createHmac('sha256', challengeSecret)
      .update(buildHostProofMacInput(transcript))
      .digest()
    send(socket, 'host-challenge', {
      challengeId,
      relayEphemeralPublicKeyB64: Buffer.from(ephemeral.publicKey).toString('base64'),
      nonceB64: Buffer.from(challengeNonce).toString('base64'),
      ciphertextB64: Buffer.from(ciphertext).toString('base64'),
      expiresAt
    })
    const proofTimer = setTimeout(() => {
      socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'host proof timeout')
    }, 10_000)
    socket.once('message', (raw, isBinary) => {
      clearTimeout(proofTimer)
      const ack = isBinary ? null : HostChallengeAckSchema.safeParse(payload(raw, 'host-challenge-ack'))
      const proof = ack?.success ? decodeCanonicalBase64(ack.data.proofB64, 32) : null
      if (
        !ack?.success ||
        ack.data.challengeId !== challengeId ||
        !proof ||
        this.now() > expiresAt ||
        !timingSafeEqual(proof, expectedProof)
      ) {
        this.observer.recordAuth(false)
        socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host proof')
        return
      }
      this.observer.recordAuth(true)
      this.guardSessionTask(
        () =>
          this.activate(
            socket,
            identity,
            existing ?? null,
            generation,
            rebind,
            hello.data.assignmentEpoch,
            hello.data.appVersion,
            connectionInclusionWatermark
          ),
        socket,
        'host activation'
      )
    })
  }

  private activate(
    socket: WebSocket,
    identity: RelayTokenClaims,
    existing: HostSession | null,
    generation: number,
    rebind: boolean,
    assignmentEpoch: number,
    appVersion: string,
    connectionInclusionWatermark?: number
  ): Promise<void> {
    const key = this.key(identity.sub, identity.relayHostId)
    const previous = this.activationQueues.get(key) ?? Promise.resolve()
    // The timeout only fails this waiting socket; the queue entry still chains
    // behind the stalled predecessor so activations never run concurrently.
    let queueWaitExpired = false
    const queueWaitTimer = setTimeout(() => {
      queueWaitExpired = true
      socket.close(RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'control activation queue stalled')
    }, ACTIVATION_QUEUE_WAIT_MS)
    queueWaitTimer.unref?.()
    const activation = previous.catch(() => undefined).then(async () => {
      clearTimeout(queueWaitTimer)
      if (queueWaitExpired) return
      if ((this.sessions.get(key) ?? null) !== existing) {
        socket.close(RELAY_CLOSE_CODE.PEER_DROPPED, 'control activation superseded')
        return
      }
      await this.activateCurrent(
        socket,
        identity,
        existing,
        generation,
        rebind,
        assignmentEpoch,
        appVersion,
        connectionInclusionWatermark
      )
    })
    this.activationQueues.set(key, activation)
    const cleanup = (): void => {
      if (this.activationQueues.get(key) === activation) this.activationQueues.delete(key)
    }
    void activation.then(cleanup, cleanup)
    return activation
  }

  private async activateCurrent(
    socket: WebSocket,
    identity: RelayTokenClaims,
    existing: HostSession | null,
    generation: number,
    rebind: boolean,
    assignmentEpoch: number,
    appVersion: string,
    connectionInclusionWatermark?: number
  ): Promise<void> {
    let controlActivityId: string | null = null
    if (this.config.role === 'cell') {
      try {
        controlActivityId = await this.assignments.activateControl(
          { userId: identity.sub, relayHostId: identity.relayHostId },
          {
            cellId: this.config.cellId,
            assignmentEpoch,
            generation,
            connectionInclusionWatermark
          }
        )
        await this.assignments.markMigrationTargetRegistered(
          { userId: identity.sub, relayHostId: identity.relayHostId },
          { cellId: this.config.cellId, assignmentEpoch }
        )
      } catch {
        // A failure after activateControl succeeded must not strand the
        // acquired control activity until lease expiry.
        if (controlActivityId) {
          this.releaseActivityBestEffort(
            { userId: identity.sub, relayHostId: identity.relayHostId },
            controlActivityId
          )
        }
        socket.close(RELAY_CLOSE_CODE.WRONG_CELL, 'assignment changed during host proof')
        return
      }
    }
    if (this.draining || socket.readyState !== socket.OPEN) {
      if (controlActivityId) {
        this.releaseActivityBestEffort(
          { userId: identity.sub, relayHostId: identity.relayHostId },
          controlActivityId
        )
      }
      if (socket.readyState === socket.OPEN) {
        socket.close(RELAY_CLOSE_CODE.DRAINING, 'relay draining')
      }
      return
    }
    if (existing) this.observer.recordReconnect()
    if (rebind && existing) {
      const previousSocket = existing.socket
      if (existing.orphanTimer) clearTimeout(existing.orphanTimer)
      existing.orphanTimer = null
      existing.socket = socket
      existing.state = existing.regionalDrainAttemptId ? 'drain-only' : 'active'
      existing.appVersion = appVersion
      existing.leaseExpiresAt = this.now() + 55 * 60 * 1000
      existing.lastPongAt = this.now()
      existing.activityRenewalDueAt =
        this.now() + RELAY_PROTOCOL_LIMITS.controlPingIntervalMs
      this.wireActiveControl(existing)
      this.sendHelloAck(existing)
      if (existing.regionalDrainAttemptId) this.reassertRegionalDrain(existing)
      previousSocket?.close(RELAY_CLOSE_CODE.PEER_DROPPED, 'control rebound')
      return
    }
    if (existing) {
      existing.state = 'closed'
      if (existing.heartbeatTimer) clearInterval(existing.heartbeatTimer)
      if (existing.orphanTimer) clearTimeout(existing.orphanTimer)
      if (existing.regionalDrainTimer) clearTimeout(existing.regionalDrainTimer)
      existing.heartbeatTimer = null
      existing.orphanTimer = null
      existing.regionalDrainTimer = null
      existing.closingCounts ??= {
        splices: existing.activeSplices.size,
        pending: existing.pendingConns.size
      }
      for (const close of existing.activeSplices.values()) close()
      for (const pending of existing.pendingConns.values()) {
        clearTimeout(pending.attachTimer)
        pending.capacityReservation?.release()
        this.failReservationBestEffort(pending.reservation)
        if (pending.credentialActivityId) {
          this.releaseActivityBestEffort(
            {
              userId: pending.reservation.userId,
              relayHostId: pending.reservation.relayHostId
            },
            pending.credentialActivityId
          )
        }
        this.rejectClient(pending.client, RELAY_CLOSE_CODE.PEER_DROPPED)
      }
      existing.socket?.close(RELAY_CLOSE_CODE.PEER_DROPPED, 'replaced by a newer generation')
      this.releaseControlActivity(existing)
    }
    const session: HostSession = {
      identity,
      relayHostId: identity.relayHostId,
      generation,
      assignmentEpoch,
      controlActivityId,
      controlResumeSecret: randomBytes(32).toString('base64url'),
      appVersion,
      state: 'active',
      socket,
      leaseExpiresAt: this.now() + 55 * 60 * 1000,
      orphanTimer: null,
      heartbeatTimer: null,
      lastPongAt: this.now(),
      activityRenewalDueAt: this.now() + RELAY_PROTOCOL_LIMITS.controlPingIntervalMs,
      activityRenewalAttempt: 0,
      activityRenewalCompletedAttempt: 0,
      activeConnIds: new Set(),
      activeSplices: new Map(),
      pendingConns: new Map(),
      closingCounts: null,
      regionalDrainAttemptId: null,
      regionalDrainTimer: null,
      regionalDrainExpiresAt: null
    }
    this.sessions.set(this.key(identity.sub, identity.relayHostId), session)
    this.wireActiveControl(session)
    this.sendHelloAck(session)
  }

  private wireActiveControl(session: HostSession): void {
    const socket = session.socket!
    const wiredAt = this.now()
    // Why: pin the build to THIS socket. A rebind refreshes session.appVersion and
    // only then closes the predecessor, whose close event always lands after that
    // write, so reading it at log time would stamp the successor's build.
    const appVersion = session.appVersion
    let socketError: string | null = null
    // Why: an unhandled ws 'error' (e.g. an oversize control frame) would
    // otherwise throw process-wide; the message also explains the close below.
    socket.on('error', (error) => {
      socketError ??= error.message
    })
    socket.once('close', (code, reason) => {
      this.observer.recordControlClose?.(code)
      // One line per control close makes reconnect churners attributable by
      // host digest without exposing the raw relay host id.
      console.warn(
        `[orca-relay] control closed host=${relayHostLogDigest(session.relayHostId)}` +
          ` gen=${session.generation} state=${session.state} ageMs=${this.now() - wiredAt}` +
          ` app=${JSON.stringify(printableCloseReason(appVersion))}` +
          ` splices=${session.closingCounts?.splices ?? session.activeSplices.size}` +
          ` pending=${session.closingCounts?.pending ?? session.pendingConns.size}` +
          ` code=${code} reason=${JSON.stringify(printableCloseReason(reason))}` +
          (socketError === null ? '' : ` error=${JSON.stringify(printableCloseReason(socketError))}`)
      )
    })
    socket.on('message', (raw, isBinary) => {
      if (isBinary || (session.state !== 'active' && session.state !== 'drain-only')) return
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>
        if (parsed.type === 'pong') {
          session.lastPongAt = this.now()
          return
        }
        if (parsed.type === 'auth-refresh') {
          // Close the socket the message arrived on: after a rebind,
          // session.socket already points at the successor.
          this.guardSessionTask(() => this.acceptRefresh(session, raw), socket, 'auth refresh')
          return
        }
        this.guardSessionTask(
          () => this.acceptControlCommand(session, parsed.type, raw),
          socket,
          'control command'
        )
      } catch {
        socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid control JSON')
      }
    })
    socket.once('close', () => {
      if (session.socket !== socket || session.state === 'closed') return
      session.socket = null
      session.state = session.regionalDrainAttemptId ? 'drain-only' : 'orphaned'
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer)
      session.heartbeatTimer = null
      session.orphanTimer = setTimeout(() => {
        session.state = 'closed'
        for (const close of session.activeSplices.values()) close()
        const key = this.key(session.identity.sub, session.relayHostId)
        if (this.sessions.get(key) === session) this.sessions.delete(key)
        this.releaseControlActivity(session)
      }, CONTROL_CONTINUITY_LIMITS.orphanGraceMs)
    })
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer)
    session.heartbeatTimer = setInterval(
      () => this.heartbeat(session),
      RELAY_PROTOCOL_LIMITS.controlPingIntervalMs
    )
  }

  private async acceptRefresh(session: HostSession, raw: RawData): Promise<void> {
    const parsed = AuthRefreshSchema.safeParse(payload(raw, 'auth-refresh'))
    if (!parsed.success) return
    const refreshed = await this.verifyRelayToken(parsed.data.relayJwt)
    const sameIdentity =
      refreshed &&
      refreshed.sub === session.identity.sub &&
      refreshed.prof === session.identity.prof &&
      refreshed.org === session.identity.org &&
      refreshed.relayHostId === session.identity.relayHostId
    if (!sameIdentity) {
      session.socket?.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'refresh identity changed')
      return
    }
    session.identity = refreshed
    if (!session.regionalDrainAttemptId) session.state = 'active'
  }

  private heartbeat(session: HostSession): void {
    const key = this.key(session.identity.sub, session.relayHostId)
    if (this.sessions.get(key) !== session || session.state === 'closed') {
      if (session.heartbeatTimer) clearInterval(session.heartbeatTimer)
      session.heartbeatTimer = null
      return
    }
    const now = this.now()
    if (!session.socket) return
    const controlActivityId = session.controlActivityId
    if (controlActivityId && now >= session.activityRenewalDueAt) {
      const attempt = ++session.activityRenewalAttempt
      const startedAt = now
      void this.assignments
        .renewControlActivity(
          { userId: session.identity.sub, relayHostId: session.relayHostId },
          {
            activityId: controlActivityId,
            cellId: this.config.cellId,
            expiresAt: startedAt + CONTROL_ACTIVITY_LEASE_MS
          }
        )
        .then(() => {
          if (attempt <= session.activityRenewalCompletedAttempt) return
          session.activityRenewalCompletedAttempt = attempt
          session.activityRenewalDueAt = startedAt + CONTROL_ACTIVITY_RENEWAL_INTERVAL_MS
        })
        .catch(async (error: unknown) => {
          if (error instanceof Error && error.message === 'activity_cell_not_authoritative') {
            // Completion fences a late drain-only heartbeat after all source work is gone.
            session.socket?.close(RELAY_CLOSE_CODE.DRAINING, 'control migration completed')
            return
          }
          if (error instanceof Error && error.message === 'control_activity_not_found') {
            if (
              this.sessions.get(key) !== session ||
              session.state === 'closed' ||
              !session.socket
            ) {
              return
            }
            try {
              await this.assignments.acquireActivity(
                { userId: session.identity.sub, relayHostId: session.relayHostId },
                {
                  activityId: controlActivityId,
                  kind: 'control',
                  cellId: this.config.cellId
                }
              )
              this.observer.recordControlActivityRecovery?.(true)
            } catch (acquireError: unknown) {
              this.observer.recordControlActivityRecovery?.(false)
              if (
                acquireError instanceof Error &&
                acquireError.message === 'activity_cell_not_authoritative'
              ) {
                session.socket?.close(RELAY_CLOSE_CODE.DRAINING, 'control migration completed')
                return
              }
              console.warn('[orca-relay] control activity recovery failed')
            }
            return
          }
          if (error instanceof Error && error.message === 'control_activity_moved') {
            session.socket?.close(RELAY_CLOSE_CODE.DRAINING, 'control activity moved')
            return
          }
          console.warn('[orca-relay] control activity renewal failed')
        })
        // Terminal handler: a throw inside the async catch above (e.g. a
        // future await) must not become a process-killing rejection.
        .catch(() => {
          console.warn('[orca-relay] control activity renewal handling failed')
        })
    }
    if (now - session.lastPongAt > 75_000) {
      session.socket.close(RELAY_CLOSE_CODE.PEER_DROPPED, 'control silence timeout')
      return
    }
    const expiresAt = session.identity.exp * 1000
    if (now > expiresAt + CONTROL_CONTINUITY_LIMITS.expiredAuthExistingSpliceGraceMs) {
      session.socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'relay authorization expired')
      return
    }
    if (now > expiresAt) session.state = 'drain-only'
    if (now > session.leaseExpiresAt) {
      send(session.socket, 'drain', { graceMs: 0, recovery: 'resolve-director' })
      session.socket.close(RELAY_CLOSE_CODE.DRAINING, 'control lease expired')
      return
    }
    send(session.socket, 'ping', { t: now })
  }

  private sendHelloAck(session: HostSession): void {
    if (!session.socket) return
    send(session.socket, 'host-hello-ack', {
      v: 1,
      generation: session.generation,
      controlResumeSecret: session.controlResumeSecret,
      leaseExpiresAt: session.leaseExpiresAt,
      activeConnIds: [...session.activeConnIds],
      pendingConns: [...session.pendingConns.values()].map((pending) => ({
        connId: pending.connId,
        connTicket: pending.connTicket
      }))
    })
  }

  private closeDrainedSession(session: HostSession): void {
    if (session.state === 'closed') return
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer)
    if (session.orphanTimer) clearTimeout(session.orphanTimer)
    if (session.regionalDrainTimer) clearTimeout(session.regionalDrainTimer)
    session.heartbeatTimer = null
    session.orphanTimer = null
    session.regionalDrainTimer = null
    session.regionalDrainExpiresAt = null
    session.closingCounts ??= {
      splices: session.activeSplices.size,
      pending: session.pendingConns.size
    }
    for (const close of session.activeSplices.values()) {
      close(RELAY_CLOSE_CODE.DRAINING, 'relay draining')
    }
    for (const pending of session.pendingConns.values()) {
      clearTimeout(pending.attachTimer)
      pending.capacityReservation?.release()
      this.failReservationBestEffort(pending.reservation)
      if (pending.credentialActivityId) {
        this.releaseActivityBestEffort(
          {
            userId: pending.reservation.userId,
            relayHostId: pending.reservation.relayHostId
          },
          pending.credentialActivityId
        )
      }
      this.rejectClient(pending.client, RELAY_CLOSE_CODE.DRAINING)
    }
    session.pendingConns.clear()
    session.state = 'closed'
    if (session.socket) {
      closeRelayWebSocket(
        session.socket,
        RELAY_CLOSE_CODE.DRAINING,
        'resolve configured director'
      )
    }
    const key = this.key(session.identity.sub, session.relayHostId)
    if (this.sessions.get(key) === session) this.sessions.delete(key)
    this.releaseControlActivity(session)
  }

  private reassertRegionalDrain(session: HostSession): void {
    session.state = 'drain-only'
    if (!session.socket) return
    send(session.socket, 'drain', {
      graceMs: Math.max(0, (session.regionalDrainExpiresAt ?? this.now()) - this.now()),
      recovery: 'resolve-director'
    })
  }

  private key(userId: string, hostId: string): string {
    return `${userId}\0${hostId}`
  }

  private async acceptControlCommand(
    session: HostSession,
    type: unknown,
    raw: RawData
  ): Promise<void> {
    if (typeof type !== 'string' || !session.socket) return
    try {
      const identity = { userId: session.identity.sub, relayHostId: session.relayHostId }
      if (type === 'invite-create') {
        if (session.state !== 'active') throw new Error('authorization_expired')
        const request = InviteCreateSchema.parse(payload(raw, type))
        const activityId = `invite-offer:${request.reqId}`
        if (this.config.role === 'cell') {
          await this.assignments.acquireActivity(identity, {
            activityId,
            kind: 'invite',
            cellId: this.config.cellId
          })
        }
        let invite
        try {
          invite = await this.store.createInvite(identity, request.relayDeviceId)
          if (this.config.role === 'cell') {
            await this.assignments.acquireActivity(identity, {
              activityId,
              kind: 'invite',
              cellId: this.config.cellId,
              expiresAt: invite.expiresAt
            })
          }
        } catch (error) {
          if (this.config.role === 'cell') {
            await this.assignments.releaseActivity(identity, activityId)
          }
          throw error
        }
        send(session.socket, 'invite-created', { reqId: request.reqId, ...invite })
        return
      }
      if (type === 'device-credential-install') {
        const request = DeviceCredentialInstallSchema.parse(payload(raw, type))
        if (
          session.state !== 'active' &&
          request.authorization.mode === 'authenticated-direct'
        ) {
          throw new Error('authorization_expired')
        }
        const installActivityId = `install:${request.reqId}`
        if (this.config.role === 'cell') {
          await this.assignments.acquireActivity(identity, {
            activityId: installActivityId,
            kind: 'install',
            cellId: this.config.cellId
          })
        }
        let result
        try {
          if (request.authorization.mode === 'authenticated-direct') {
            await this.store.recordDirectAuthorization({
              ...identity,
              relayDeviceId: request.relayDeviceId,
              directAuthId: request.authorization.directAuthId,
              owningControlGeneration: session.generation,
              deadline: this.now() + RELAY_PROTOCOL_LIMITS.resumeConfirmationDeadlineMs
            })
          }
          result = await this.store.installCredential({
            ...identity,
            ...request,
            owningControlGeneration: session.generation
          })
        } finally {
          if (this.config.role === 'cell') {
            await this.assignments.releaseActivity(identity, installActivityId)
          }
        }
        if (request.authorization.mode === 'relay-basis') {
          await this.assignments.releaseActivity(
            identity,
            `invite:${request.authorization.basisConnId}`
          )
        }
        send(session.socket, 'device-credential-installed', result)
        return
      }
      if (type === 'device-credential-install-status') {
        const request = DeviceCredentialInstallStatusSchema.parse(payload(raw, type))
        const result = await this.store.installStatus({ ...identity, ...request })
        send(session.socket, 'device-credential-install-status-result', {
          v: 1,
          reqId: request.reqId,
          state: result ? 'committed' : 'not-found',
          ...(result ? { result } : {})
        })
        return
      }
      if (type === 'device-resume-confirm') {
        const request = DeviceResumeConfirmSchema.parse(payload(raw, type))
        const result = await this.store.confirmResume({
          ...identity,
          ...request,
          owningControlGeneration: session.generation
        })
        await this.assignments.releaseActivity(identity, `confirmation:${request.basisConnId}`)
        send(session.socket, 'device-resume-confirmed', result)
        return
      }
      if (type === 'device-revoke') {
        const request = DeviceRevokeSchema.parse(payload(raw, type))
        await this.store.revoke(identity, request.relayDeviceId)
        send(session.socket, 'device-revoked', { reqId: request.reqId })
        return
      }
      this.sendControlError(session, undefined, 'unknown_control_message')
    } catch (error) {
      const reqId = (() => {
        const candidate = payload(raw, type)
        return typeof candidate === 'object' && candidate && 'reqId' in candidate
          ? String(candidate.reqId)
          : undefined
      })()
      this.sendControlError(
        session,
        reqId,
        error instanceof Error ? error.message : 'control_operation_failed'
      )
    }
  }

  private sendControlError(session: HostSession, reqId: string | undefined, code: string): void {
    if (session.socket) send(session.socket, 'control-error', { ...(reqId ? { reqId } : {}), code })
  }

  private rejectClient(socket: WebSocket, code: number): void {
    send(socket, 'relay-hello', { ok: false, code })
    closeRelayWebSocket(socket, code, 'relay connection rejected')
  }

  private releaseControlActivity(session: HostSession): void {
    if (!session.controlActivityId) return
    this.releaseActivityBestEffort(
      { userId: session.identity.sub, relayHostId: session.relayHostId },
      session.controlActivityId
    )
  }

  private releaseActivityBestEffort(identity: RelayIdentityKey, activityId: string): void {
    void this.assignments.releaseActivity(identity, activityId).catch(() => {
      // Why: expiry cleanup is the durable fallback; a transient SQL failure while
      // closing a socket must not become an unhandled rejection that kills the cell.
      console.warn('[orca-relay] activity release deferred to lease cleanup')
    })
  }

  private failReservationBestEffort(reservation: CredentialReservation): void {
    // Why: reservation deadlines and basis cleanup are durable recovery paths;
    // transient SQL errors during socket callbacks must stay process-contained.
    void this.store.failReservation(reservation).catch(() => {
      console.warn('[orca-relay] reservation release deferred to credential cleanup')
    })
  }

  private deactivateBasisBestEffort(connId: string): void {
    void this.store.deactivateBasis(connId).catch(() => {
      console.warn('[orca-relay] basis deactivation deferred to credential cleanup')
    })
  }
}

export type RelayIdentityKey = { userId: string; relayHostId: string }
