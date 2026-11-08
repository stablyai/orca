// One Durable Object per relay host. Owns the host control socket, the session (generation,
// resume secret, orphan grace), the host's connection bookkeeping and its credential commands.
// Phone connections and their host data sockets live in a pool of SpliceRelay objects (one per
// slot, reused across connects), so a flooding phone cannot reset this one and a connect never
// creates a new object. The control socket uses the Hibernation API; durable state lives in object
// storage; credentials and assignments are the relay's Postgres tables, through Hyperdrive.
// The class is layered (host-relay-base → -handshake → -control → -phones → this file) only to keep
// files small; it is one object with one state.
import { parseRelayHostCapabilities } from '../../../packages/relay-contract/src/control-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { CONTROL_CONTINUITY_LIMITS } from '../../../packages/relay-contract/src/control-continuity'
import { metric } from './metrics'
import { RelayCredentialStore } from '../../relay/src/credentials/credential-store'
import type { AssignBody, DeviceRow } from './admin'
import { ADMIN_JTI_KEY, admitJti, type AdminReplayGuard, type ReplayRefusal, type SeenJtis } from './admin-jti'
import type { AssignResult, StoredAssignment } from './object-store'
import type { EdgeClaims } from './env'
import { SWEEP_AT_KEY, type Session } from './host-relay-base'
import { HostRelayPhones } from './host-relay-phones'

export type { AuthorizeResult, ConfirmResult } from './host-relay-base'

export class HostRelay extends HostRelayPhones {
  // ---------------- director admin (phase 2; the Worker verified the signed request) ----------------

  // Every op records its token's jti before it runs (admin-jti.ts), so a copy of the token is
  // refused 409 even while the first call is still in flight. `replay` is null for tokens
  // without a jti (transitional) and undefined from a Worker deployed before this field.
  async adminAssign(body: AssignBody, replay?: AdminReplayGuard | null): Promise<AssignResult | ReplayRefusal> {
    const refused = await this.claimAdminJti(replay)
    if (refused) { return refused }
    const result = await this.store.applyAssignment(body)
    if (result.outcome === 'applied' && body.cellId !== this.config.cellId) {
      // Moved away: like an old cell, send the desktop and its phones back to the director.
      for (const ws of this.ctx.getWebSockets('control')) { this.close(ws, RELAY_CLOSE_CODE.WRONG_CELL, 'host moved') }
      await this.closeSplices(() => true, RELAY_CLOSE_CODE.WRONG_CELL, 'host moved')
    }
    // Arms the daily sweep for objects that have not been woken since it existed.
    await this.reschedule()
    return result
  }

  // The director's move away: refused while the desktop is connected (it alone can change
  // devices); otherwise the host is frozen (hello and phones get WRONG_CELL) and snapshotted.
  async adminExport(replay?: AdminReplayGuard | null): Promise<
    ReplayRefusal | { outcome: 'busy' } | { outcome: 'exported'; assignment: StoredAssignment | null; devices: DeviceRow[] }
  > {
    const refused = await this.claimAdminJti(replay)
    if (refused) { return refused }
    if (this.liveControls().length > 0) { return { outcome: 'busy' } }
    const devices = this.store.freezeForExport()
    await this.closeSplices(() => true, RELAY_CLOSE_CODE.WRONG_CELL, 'host moving')
    await this.reschedule()
    return { outcome: 'exported', assignment: this.store.assignment(), devices }
  }

  // Erasure: refused while the host is live, as today's guard; otherwise every byte of the object goes.
  // An erasure wipes the recorded jti with everything else: a copy of the token then finds an
  // empty object, and erasing it again changes nothing.
  async adminErase(userId: string, replay?: AdminReplayGuard | null): Promise<{ outcome: 'erased' | 'busy' | 'mismatch' | ReplayRefusal['outcome'] }> {
    const refused = await this.claimAdminJti(replay)
    if (refused) { return refused }
    const assignment = this.store.assignment()
    // Another account now holds this machine's object; its move on wiped the earlier account's data.
    if (assignment && assignment.userId !== userId) { return { outcome: 'mismatch' } }
    if (this.ctx.getWebSockets('control').length > 0 || this.store.activeBases() > 0) { return { outcome: 'busy' } }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.storeCache = null
    this.backendCache = null
    return { outcome: 'erased' }
  }

  // The director takes the host off the edge: every control gets the lease-expiry drain (the
  // desktop re-asks the director), and goes through the same path as that expiry. The assignment,
  // devices and splices are left as they are.
  async adminDrain(replay?: AdminReplayGuard | null): Promise<ReplayRefusal | { outcome: 'idle' } | { outcome: 'drained'; controls: number }> {
    const controls = this.liveControls()
    // An idle drain of a host nobody pushed changes nothing and must not give the object storage,
    // so its jti is not recorded; a copy of that token can at most drain a control that arrived
    // since, which sends the desktop back to the director once.
    const refused = controls.length > 0 || this.pushed() ? await this.claimAdminJti(replay) : null
    if (refused) { return refused }
    if (controls.length === 0) { return { outcome: 'idle' } }
    for (const ws of controls) {
      this.send(ws, { type: 'drain', graceMs: 0, recovery: 'resolve-director' })
      this.close(ws, RELAY_CLOSE_CODE.DRAINING, 'host leaving edge')
      await this.onSocketGone(ws, RELAY_CLOSE_CODE.DRAINING, '')
    }
    return { outcome: 'drained', controls: controls.length }
  }

  // A socket whose attachment is cleared is already gone (closing, still listed): drain and export
  // both ignore it, so a just-drained desktop does not make the export that follows answer busy.
  private liveControls(): WebSocket[] {
    return this.ctx.getWebSockets('control').filter((ws) => this.attachment(ws) !== null)
  }

  // Health probe (GET /__health/object, health.ts), only ever called on the canary object: one
  // read of the object's SQLite. No writes, no alarm, no storage created.
  healthCheck(): { ok: true } {
    this.ctx.storage.sql.exec('SELECT 1').one()
    return { ok: true }
  }

  private async claimAdminJti(replay: AdminReplayGuard | null | undefined): Promise<ReplayRefusal | null> {
    if (!replay) { return null }
    // Only storage calls between the read and the write: no other event runs in between.
    const { outcome, seen } = admitJti(await this.ctx.storage.get<SeenJtis>(ADMIN_JTI_KEY), replay, Date.now())
    if (outcome !== 'fresh') { return { outcome } }
    await this.ctx.storage.put(ADMIN_JTI_KEY, seen)
    return null
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
    if (kind !== 'control') { return new Response(null, { status: 404 }) }
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
    if (!a) { return }
    return this.onControl(ws, a, message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.onSocketGone(ws, code, reason)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws, 1006, '')
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws)
      if (!a) { continue }
      if (a.k === 'control' && a.phase === 'active') {
        if (now - (a.lastPongAt ?? now) > this.config.silenceTimeoutMs) {
          this.close(ws, RELAY_CLOSE_CODE.PEER_DROPPED, 'control silence timeout')
          await this.onSocketGone(ws, RELAY_CLOSE_CODE.PEER_DROPPED, '')
          continue
        }
        // Same order as the cells' heartbeat: expired auth past its grace, then the 6 h lease.
        if (now > a.claims.exp + CONTROL_CONTINUITY_LIMITS.expiredAuthExistingSpliceGraceMs) {
          const sinceRefreshS = a.lastRefreshAt === undefined ? -1 : Math.round((now - a.lastRefreshAt) / 1000)
          metric(this.env, 'auth_expired_close', sinceRefreshS, a.lastRefreshAt === undefined ? 'never' : 'refreshed', [], '', a.place)
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
          if (a.lastPingAt) { metric(this.env, 'alarm_lag_ms', Math.max(0, now - (a.lastPingAt + this.config.pingIntervalMs)), '', [], '', a.place) }
          this.send(ws, { type: 'ping', t: now })
          a.lastPingAt = now
          this.attach(ws, a)
        }
        continue
      }
      if (now >= a.deadline) {
        if (a.phase === 'checking') { this.close(ws, RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'relay temporarily unavailable') }
        else { this.close(ws, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, a.phase === 'proof' ? 'invalid host proof' : 'first frame timeout') }
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
      if (sweepAt !== undefined && sweepAt <= now && (await this.sweep(now)) === 'wiped') { return }
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
}
