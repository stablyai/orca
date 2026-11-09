// HostRelay control handshake: host-hello (key binding, assignment check, challenge), rebind
// eligibility, and the proof that activates a control (generation, resume secret, pending conns).
import nacl from 'tweetnacl'
import { buildHostChallengePlaintext, buildHostProofMacInput, buildHostProofTranscript } from '../../../packages/relay-contract/src/host-proof-transcript'
import { HostChallengeAckSchema, HostHelloSchema, RELAY_HOST_CAPABILITY_CLIENT_KEEPALIVE, RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS } from '../../../packages/relay-contract/src/control-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { metric } from './metrics'
import type { EdgeClaims } from './env'
import { b64, b64url, fromB64, hmacSha256, sha256B64url, timingSafeEqualStr } from './bytes'
import { HostRelayBase, ASSIGNMENT_CHECK_DEADLINE_MS, NO_DEADLINE, LEASE_BASE_MS, LEASE_JITTER_MS, type ControlAttachment, type Session } from './host-relay-base'

export abstract class HostRelayHandshake extends HostRelayBase {
  protected async onHostHello(ws: WebSocket, a: ControlAttachment, type: unknown, body: Record<string, unknown>): Promise<void> {
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
    if (!current || current.k !== 'control' || current.phase !== 'checking') { return }
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
  protected async canRebind(
    ws: WebSocket,
    claims: EdgeClaims,
    previousGeneration: number | undefined,
    secret: string | undefined
  ): Promise<boolean> {
    if (secret === undefined) { return false }
    const stored = await this.ctx.storage.get<Session>('session')
    if (!stored) { return false }
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


  protected async onHostProof(ws: WebSocket, a: ControlAttachment, type: unknown, body: Record<string, unknown>): Promise<void> {
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
      for (const old of otherControls) { this.close(old, RELAY_CLOSE_CODE.PEER_DROPPED, 'control rebound') }
    } else {
      generation = (stored?.generation ?? 0) + 1
      resumeSecret = b64url(nacl.randomBytes(32))
      for (const old of otherControls) { this.close(old, RELAY_CLOSE_CODE.PEER_DROPPED, 'replaced by a newer generation') }
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
    a.clientKeepalive = this.config.clientKeepalive && a.caps.includes(RELAY_HOST_CAPABILITY_CLIENT_KEEPALIVE)
    delete a.expectedProof
    delete a.hello
    delete a.rebind
    this.attach(ws, a)
    const details = a.caps.includes(RELAY_HOST_CAPABILITY_PENDING_CONN_DETAILS)
    const activeConnIds: string[] = []
    const pendingConns: Record<string, unknown>[] = []
    for (const [connId, c] of Object.entries(await this.conns())) {
      if (c.phase === 'active') { activeConnIds.push(connId) }
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
    // After the ack, which strict shipped parsers must see unchanged; only hosts that asked get it.
    if (a.clientKeepalive) { this.send(ws, { type: 'keepalive-offer', v: 1, intervalMs: this.config.pingIntervalMs }) }
    metric(this.env, 'control_active', 1, rebind ? 'rebind' : 'new', [], '', a.place)
    await this.reschedule()
  }
}
