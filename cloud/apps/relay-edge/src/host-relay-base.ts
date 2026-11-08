// HostRelay's state and shared plumbing: socket attachments, the session, the host's connection
// bookkeeping (splice pool), alarm scheduling. The class chain is base → handshake → control →
// phones → HostRelay (host-relay.ts); each layer adds one group of handlers, nothing overrides.
import { DurableObject } from 'cloudflare:workers'
import type { RelayHello } from '../../../packages/relay-contract/src/credential-messages'
import { RELAY_CLOSE_CODE } from '../../../packages/relay-contract/src/close-codes'
import { CONTROL_CONTINUITY_LIMITS } from '../../../packages/relay-contract/src/control-continuity'
import { ASSIGNMENT_LIMITS } from '../../../packages/relay-contract/src/assignment-invariants'
import { relayHostCloseReasonFrom } from '../../../packages/relay-contract/src/host-close-reason'
import { parseConnId } from './splice-slot'
import { metric } from './metrics'
import { ObjectStore } from './object-store'
import { edgeConfig, type EdgeClaims, type EdgeConfig, type Env } from './env'
import { edgeBackend, type CredentialReservation, type EdgeBackend } from './edge-backend'

// Longer than one database operation can take (connect 2 s + query 5 s, edge-database.ts).
export const ASSIGNMENT_CHECK_DEADLINE_MS = 8_000

export type ControlAttachment = {
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
  // Last inbound frame of any kind once active (named for pongs, which used to be the only signal).
  lastPongAt?: number
  lastPingAt?: number
  leaseExpiresAt?: number
  // Last auth-refresh that extended the token (absent on attachments from before this field).
  lastRefreshAt?: number
  // Client ingress '<continent>/<colo>', for metrics.
  place?: string
}
export type Attachment = ControlAttachment
export type Conn = {
  phase: 'pending' | 'active'
  generation: number
  connTicket?: string
  reservation: CredentialReservation
}

export type Session = {
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

export const NO_DEADLINE = Number.MAX_SAFE_INTEGER
export const SWEEP_AT_KEY = 'sweepAt'
// 6 h ± 30 min, as the cells: desktops re-ask the director at least this often.
export const LEASE_BASE_MS = 6 * 60 * 60 * 1000
export const LEASE_JITTER_MS = 30 * 60 * 1000
export const GENERIC_REJECT_REASON = 'relay connection rejected'

export abstract class HostRelayBase extends DurableObject<Env> {
  // A reset (code update past max_delay, runtime restart, eviction) drops sockets without close
  // events. A stored session with no live control is then treated as orphaned from this boot, so the
  // desktop can rebind within the grace and keep splices, which live in SpliceRelay objects.
  protected readonly bootAt = Date.now()
  // Slots handed out recently whose phone hasn't authorized yet (in memory; a hint only).
  protected recentPicks: { slot: number; at: number }[] = []
  protected backendCache: EdgeBackend | null = null

  protected get config(): EdgeConfig {
    return edgeConfig(this.env)
  }

  protected get backend(): EdgeBackend {
    this.backendCache ??= edgeBackend(this.env, this.config.backend === 'object' ? { database: this.store.database, assignments: this.store } : undefined)
    return this.backendCache
  }

  // Phase 2: this host's credential tables and pushed assignment, in the object's own SQLite.
  protected storeCache: ObjectStore | null = null
  protected get store(): ObjectStore {
    this.storeCache ??= new ObjectStore(this.ctx.storage.sql, (operation) => this.ctx.storage.transaction(() => operation()), this.config.cellId)
    return this.storeCache
  }

  // Active until the relay token expires; after that the seat only drains (cells: drain-only).
  protected authActive(a: ControlAttachment, now = Date.now()): boolean {
    return a.phase === 'active' && now <= a.claims.exp
  }

  protected otherActiveControls(ws: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets('control').filter((s) => s !== ws && this.attachment(s)?.phase === 'active')
  }

  protected activeControl(): { ws: WebSocket; a: ControlAttachment } | null {
    for (const ws of this.ctx.getWebSockets('control')) {
      const a = this.attachment(ws)
      if (a?.k === 'control' && a.phase === 'active') { return { ws, a } }
    }
    return null
  }

  // Best effort, as the cells: a pending phone's invite reservation goes back (cooldown), an
  // attached one's basis is deactivated; credential cleanup on the directors covers misses.
  protected async releaseConn(connId: string, conn: Conn): Promise<void> {
    const release =
      conn.phase === 'pending' ? this.backend.failReservation(conn.reservation) : this.backend.deactivateBasis(connId)
    await release.catch(() => {})
  }

  protected async conns(): Promise<Record<string, Conn>> {
    return (await this.ctx.storage.get<Record<string, Conn>>('conns')) ?? {}
  }


  protected splice(connId: string) {
    const object = parseConnId(connId)?.object ?? connId
    return this.env.SPLICE_RELAY.get(this.env.SPLICE_RELAY.idFromName(object))
  }

  protected async closeSplices(filter: (c: Conn) => boolean, code: number, reason: string): Promise<void> {
    const conns = await this.conns()
    const ids = Object.keys(conns).filter((id) => filter(conns[id]))
    if (ids.length === 0) { return }
    await Promise.all(ids.map((id) => this.splice(id).closeSplice(id, code, reason).catch(() => {})))
    const closed = ids.map((id) => [id, conns[id]] as const)
    for (const id of ids) { delete conns[id] }
    await this.ctx.storage.put('conns', conns)
    await Promise.all(closed.map(([id, conn]) => this.releaseConn(id, conn)))
  }

  // ---------------- lifecycle ----------------

  protected async onSocketGone(ws: WebSocket, code: number, reason: string): Promise<void> {
    const a = this.attachment(ws)
    if (!a) { return }
    // During webSocketClose the closing socket is still listed; clear it first so it can't count as live.
    this.attach(ws, null)
    if (a.k === 'control' && a.phase === 'active') { metric(this.env, 'control_close', 1, String(code), [], '', a.place) }
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

  protected async reschedule(): Promise<void> {
    let next = NO_DEADLINE
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachment(ws)
      if (!a) { continue }
      next = Math.min(
        next,
        ...(a.k === 'control' && a.phase === 'active'
          ? [
              (a.lastPingAt ?? 0) + this.config.pingIntervalMs,
              a.claims.exp + CONTROL_CONTINUITY_LIMITS.expiredAuthExistingSpliceGraceMs + 1,
              (a.leaseExpiresAt ?? NO_DEADLINE - 1) + 1
            ]
          : [a.deadline])
      )
    }
    const session = await this.ctx.storage.get<Session>('session')
    if (session?.orphanedAt != null) { next = Math.min(next, session.orphanedAt + this.config.orphanGraceMs) }
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

  protected attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  }

  protected attach(ws: WebSocket, a: Attachment | null): void {
    ws.serializeAttachment(a)
  }

  protected send(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      // Socket already closing.
    }
  }

  protected close(ws: WebSocket, code: number, reason: string): void {
    metric(this.env, 'refuse', 1, `control:${code}`, [], reason, this.attachment(ws)?.place)
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}
