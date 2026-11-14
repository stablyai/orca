// HostRelay RPCs for phones: slot allocation from the Worker, and phone authorization, splice
// confirmation and close from the SpliceRelay objects.
import nacl from 'tweetnacl'
import type { RelayHello } from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import { SPLICE_SLOTS, makeConnId, parseConnId } from './splice-slot'
import type { CredentialReservation } from './edge-backend'
import { b64url } from './bytes'
import { HostRelayControl } from './host-relay-control'
import { GENERIC_REJECT_REASON, type Conn, type Session, type AuthorizeResult, type ConfirmResult } from './host-relay-base'

export abstract class HostRelayPhones extends HostRelayControl {
  // ---------------- RPC from the Worker ----------------

  // Picks the least-busy slot of this host's splice pool for a new phone connection, so concurrent
  // phones land in different objects. Ties go to a random slot. Not a reservation: a slot can still
  // hold several splices, and the 8-connection budget is enforced in authorizePhone.
  // Object backend: null for a host the director has not pushed (never, or wiped since), so the
  // Worker answers the phone without this object or a splice object writing any storage.
  async allocateConnId(relayHostId: string): Promise<string | null> {
    if (this.config.backend === 'object' && !this.pushed()) { return null }
    const now = Date.now()
    this.recentPicks = this.recentPicks.filter((p) => now - p.at < 15_000)
    const load = new Array<number>(SPLICE_SLOTS).fill(0)
    for (const connId of Object.keys(await this.conns())) {
      const parsed = parseConnId(connId)
      if (parsed) { load[parsed.slot]++ }
    }
    for (const p of this.recentPicks) { load[p.slot]++ }
    const min = Math.min(...load)
    const candidates = load.flatMap((n, slot) => (n === min ? [slot] : []))
    const slot = candidates[Math.floor(Math.random() * candidates.length)]
    this.recentPicks.push({ slot, at: now })
    return makeConnId(relayHostId, slot)
  }

  // Read-only: an object nobody pushed has no tables, and this must not create them.
  protected pushed(): boolean {
    const sql = this.ctx.storage.sql
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edge_assignment'").toArray().length === 0) { return false }
    return sql.exec('SELECT 1 FROM edge_assignment WHERE id = 1').toArray().length > 0
  }

  // ---------------- RPC from SpliceRelay ----------------

  // Phone presented relay-auth to its splice object. Same order and answers as a cell
  // (host-session-registry acceptClient): one device read for a resume token, else the invite/
  // reservation path; a refused token is 4401; a missing seat is 4409 when the assignment names
  // another cell, else 4404; a full host is 4429. Database failures answer 4503, never 4401.
  async authorizePhone(connId: string, credentialToken: string): Promise<AuthorizeResult> {
    const hostId = parseConnId(connId)?.relayHostId
    if (!hostId) { return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL } }
    let reservation: CredentialReservation | null
    try {
      const found = await this.backend.lookupResume(hostId, credentialToken)
      if (found.outcome === 'refused') { return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL } }
      reservation =
        found.outcome === 'resume' ? found.reservation : await this.backend.reserveCredential(hostId, credentialToken)
    } catch {
      return { ok: false, code: RELAY_CLOSE_CODE.DRAINING }
    }
    if (!reservation) { return { ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL } }
    // A keepalive host may have died unnoticed (no alarm watches an idle one): probe it first.
    await this.probeSilentControls()
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
    if (pickIndex !== -1) { this.recentPicks.splice(pickIndex, 1) }
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
    // The first phone of a keepalive host arms its silence check (reschedule).
    if (this.keepalive(control.a)) { await this.reschedule() }
    return { ok: true, connTicket, generation }
  }

  protected async missedSeat(reservation: CredentialReservation): Promise<AuthorizeResult> {
    let elsewhere: boolean
    try {
      elsewhere = await this.backend.assignedElsewhere(reservation.userId, reservation.relayHostId)
    } catch {
      // As the cells: an unreadable row sends the phone to its director rather than pinning it.
      elsewhere = true
    }
    if (elsewhere) { return { ok: false, code: RELAY_CLOSE_CODE.WRONG_CELL } }
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
    if (!conn) { return }
    delete conns[connId]
    await this.ctx.storage.put('conns', conns)
    await this.releaseConn(connId, conn)
  }

  // A splice object that was reset never reports its close. Ask before refusing on the budget.
  protected async pruneDeadConns(conns: Record<string, Conn>): Promise<void> {
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
}
