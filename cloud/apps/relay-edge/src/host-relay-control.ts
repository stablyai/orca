// HostRelay control frames once a host is past the handshake: pongs, auth refresh and the host's
// credential commands.
import { AuthRefreshSchema, DeviceRevokeSchema, InviteCreateSchema } from '../../../packages/relay-contract/src/control-messages'
import { DeviceCredentialInstallSchema, DeviceCredentialInstallStatusSchema, DeviceResumeConfirmSchema } from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { verifyRelayJwt } from './jwt'
import { metric } from './metrics'
import { controlErrorCode } from './edge-backend'
import { CONTROL_MAX_FRAME_BYTES, MESSAGE_TOO_BIG, frameOver } from './bytes'
import { HostRelayHandshake } from './host-relay-handshake'
import type { ControlAttachment } from './host-relay-base'

export abstract class HostRelayControl extends HostRelayHandshake {
  // ---------------- control ----------------

  protected async onControl(ws: WebSocket, a: ControlAttachment, message: string | ArrayBuffer): Promise<void> {
    if (frameOver(message, CONTROL_MAX_FRAME_BYTES)) {
      this.close(ws, MESSAGE_TOO_BIG, 'frame too large')
      return
    }
    if (typeof message !== 'string') {
      if (a.phase !== 'active') { this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'binary hello') }
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
    if (a.phase === 'hello') { return this.onHostHello(ws, a, type, body) }
    // The client waits for the challenge; nothing else is valid until then.
    if (a.phase === 'checking') { return }
    if (a.phase === 'proof') { return this.onHostProof(ws, a, type, body) }
    if (type === 'pong') {
      a.lastPongAt = Date.now()
      if (typeof body.t === 'number') { metric(this.env, 'pong_rtt_ms', a.lastPongAt - body.t, '', [], '', a.place) }
      this.attach(ws, a)
      return
    }
    if (type === 'auth-refresh') { return this.onAuthRefresh(ws, body) }
    return this.onCommand(ws, a, type, body)
  }

  protected async onAuthRefresh(ws: WebSocket, body: Record<string, unknown>): Promise<void> {
    const parsed = AuthRefreshSchema.safeParse(body)
    if (!parsed.success) { return }
    const claims = await verifyRelayJwt(this.env, parsed.data.relayJwt)
    // Re-read after the await: the attachment may have moved on (pongs, pings) meanwhile.
    const current = this.attachment(ws)
    if (!current || current.k !== 'control') { return }
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
    if (claims.exp > current.claims.exp) { current.claims = claims }
    this.attach(ws, current)
    await this.reschedule()
  }

  // Host credential commands: same messages and error codes as the cells
  // (host-session-registry acceptControlCommandUnfenced), through the shared credential store.
  // Edge hosts write no activity leases (design: R10); bases and token expiry cover erasure.
  protected async onCommand(ws: WebSocket, a: ControlAttachment, type: unknown, body: Record<string, unknown>): Promise<void> {
    if (typeof type !== 'string') { return }
    const identity = { userId: a.claims.userId, relayHostId: a.claims.relayHostId }
    const generation = a.generation ?? 0
    try {
      if (type === 'invite-create') {
        if (!this.authActive(a)) { throw new Error('authorization_expired') }
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
}
