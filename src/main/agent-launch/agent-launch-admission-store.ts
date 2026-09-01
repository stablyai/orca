// Host-private admitted-pending launch store and the admission coordinator.
// Admission is the launch linearization point (I24): inside one short critical
// section the host revalidates the relevant-input fingerprint and commits the
// token/snapshot/provider intent BEFORE any provider I/O. Records are bounded:
// 256 per host, 64 per authenticated principal (per paired device for remote
// callers, so one phone cannot spend another's slots), remote principals collectively
// capped so 64 slots stay reserved for local desktop/host work. Rejection is
// launch_capacity_exceeded before provider I/O and before any owner mutation.

import { randomBytes } from 'node:crypto'
import type {
  AgentLaunchExecutionHostId,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import type { AgentLaunchFailure, AgentLaunchIntentKind } from '../../shared/agent-launch-contract'
import type { BuiltInTuiAgent } from '../../shared/types'

export const MAX_PENDING_LAUNCHES_PER_HOST = 256
export const MAX_PENDING_LAUNCHES_PER_PRINCIPAL = 64
export const MAX_PENDING_LAUNCHES_REMOTE_TOTAL = 192
// Per-worktree bound (G6): unattended launches (orchestration workers, automation
// runs, background attempts) can pile many pending launches into ONE worktree, so
// a worktree-scoped cap stops a single workspace from monopolizing host capacity.
export const MAX_PENDING_LAUNCHES_PER_WORKTREE = 8

/** Stable authenticated principal: the remote caller's clientKind ('mobile' |
 *  'runtime') plus the paired device it authenticated as, the local desktop/host
 *  otherwise. Never a per-connection value.
 *  `deviceId` is what makes caps, recovery rows, and idempotency keys per-device;
 *  it is OPTIONAL only because rows persisted before per-device principals landed
 *  carry the coarse clientKind alone. Such a legacy row keeps the coarse bucket and
 *  stays claimable by any device of its kind (see admissionPrincipalOwns) so it
 *  never becomes unforgettable; every new remote principal must carry a deviceId. */
export type AdmissionPrincipal =
  | { kind: 'local' }
  | { kind: 'remote'; id: string; deviceId?: string }

export type AdmittedLaunchRecord = {
  launchToken: string
  principal: AdmissionPrincipal
  intent: AgentLaunchIntentKind
  /** Owner scope for reconciliation joins (worktree id, pane key, run id …). */
  scope: string
  /** Worktree this launch targets, for the per-worktree cap. Null when the
   *  launch names no worktree (e.g. a not-yet-created two-stage worktree). */
  worktreeId: string | null
  fingerprint: string
  snapshot: AgentLaunchSnapshot
  admittedAt: number
}

export type AdmissionResult =
  | { ok: true; record: AdmittedLaunchRecord }
  | { ok: false; failure: AgentLaunchFailure }

/** Redacted host-side capacity-recovery row for the pending-summary surface.
 *  Adds only the two non-secret snapshot fields the sheet needs (base harness,
 *  execution host id) to the summarize set; the launch token stays host-side for
 *  the liveness scan and is never projected to the client DTO. */
export type AdmissionCapacityRow = {
  intent: AgentLaunchIntentKind
  scope: string
  admittedAt: number
  launchToken: string
  baseHarness: BuiltInTuiAgent
  executionHostId: AgentLaunchExecutionHostId
}

/** Fields common to a fresh admit and a reserved admit. Principal comes from the
 *  request for admit and from the held reservation for admitReserved. */
export type AgentLaunchAdmitInput = {
  intent: AgentLaunchIntentKind
  scope: string
  /** Target worktree for the per-worktree cap, or null when the launch names no
   *  worktree yet (a fresh two-stage creation counts trivially against a brand-
   *  new worktree, so a null-worktree reservation never hits the cap). */
  worktreeId: string | null
  fingerprint: string
  snapshot: AgentLaunchSnapshot
  admittedAt: number
}

/** A pre-spawn capacity hold taken before git/worktree mutation so a
 *  launch_capacity_exceeded rejection precedes any side effect. Converted into a
 *  committed record by admitReserved, or dropped by releaseReservation on any
 *  pre-spawn exit. Counts toward the caps while held. */
export type AdmissionReservation = { reservationId: string; principal: AdmissionPrincipal }

export type ReservationResult =
  | { ok: true; reservation: AdmissionReservation }
  | { ok: false; failure: AgentLaunchFailure }

export function principalKey(principal: AdmissionPrincipal): string {
  if (principal.kind === 'local') {
    return 'local'
  }
  // A device-scoped key gives each paired device its own cap bucket; a legacy
  // principal (no deviceId) keeps the pre-device key so persisted rows rebuild
  // into the bucket they were counted in.
  return principal.deviceId
    ? `remote:${principal.id}#${principal.deviceId}`
    : `remote:${principal.id}`
}

/** Does `caller` own a record admitted by `stored`? Exact device match for a
 *  device-scoped record; a legacy record (persisted with no deviceId, or with no
 *  principal at all) stays owned by any device of the same kind so it never
 *  becomes unforgettable after the upgrade. */
export function admissionPrincipalOwns(
  caller: AdmissionPrincipal,
  stored: AdmissionPrincipal | undefined
): boolean {
  if (!stored) {
    return true
  }
  if (caller.kind !== stored.kind) {
    return false
  }
  if (caller.kind !== 'remote' || stored.kind !== 'remote') {
    return true
  }
  if (caller.id !== stored.id) {
    return false
  }
  return stored.deviceId === undefined || caller.deviceId === stored.deviceId
}

export class AgentLaunchAdmissionStore {
  private readonly byToken = new Map<string, AdmittedLaunchRecord>()
  private readonly countsByPrincipal = new Map<string, number>()
  private readonly countsByWorktree = new Map<string, number>()
  private readonly reservations = new Map<string, AdmissionPrincipal>()
  private remoteTotal = 0

  /** launch_capacity_exceeded when any cap is at its bound, else null. Held
   *  reservations count toward the principal/host/remote caps; the per-worktree
   *  cap counts only committed records (a two-stage reservation has no worktree
   *  yet). */
  private capacityFailure(
    principal: AdmissionPrincipal,
    worktreeId: string | null
  ): AgentLaunchFailure | null {
    const principalCount = this.countsByPrincipal.get(principalKey(principal)) ?? 0
    const worktreeCount = worktreeId ? (this.countsByWorktree.get(worktreeId) ?? 0) : 0
    if (
      this.byToken.size + this.reservations.size >= MAX_PENDING_LAUNCHES_PER_HOST ||
      principalCount >= MAX_PENDING_LAUNCHES_PER_PRINCIPAL ||
      // Remote principals collectively stop short of the host cap so local
      // desktop/host work always retains reserved capacity.
      (principal.kind === 'remote' && this.remoteTotal >= MAX_PENDING_LAUNCHES_REMOTE_TOTAL) ||
      (worktreeId !== null && worktreeCount >= MAX_PENDING_LAUNCHES_PER_WORKTREE)
    ) {
      return { code: 'launch_capacity_exceeded', reason: 'capacity' }
    }
    return null
  }

  private incrementCounters(principal: AdmissionPrincipal): void {
    const key = principalKey(principal)
    this.countsByPrincipal.set(key, (this.countsByPrincipal.get(key) ?? 0) + 1)
    if (principal.kind === 'remote') {
      this.remoteTotal += 1
    }
  }

  private decrementCounters(principal: AdmissionPrincipal): void {
    const key = principalKey(principal)
    const count = this.countsByPrincipal.get(key) ?? 0
    if (count <= 1) {
      this.countsByPrincipal.delete(key)
    } else {
      this.countsByPrincipal.set(key, count - 1)
    }
    if (principal.kind === 'remote') {
      this.remoteTotal = Math.max(0, this.remoteTotal - 1)
    }
  }

  /** Per-worktree counters track committed records only. Called when a record
   *  is committed (admit / admitReserved) and released. */
  private incrementWorktree(worktreeId: string | null): void {
    if (!worktreeId) {
      return
    }
    this.countsByWorktree.set(worktreeId, (this.countsByWorktree.get(worktreeId) ?? 0) + 1)
  }

  private decrementWorktree(worktreeId: string | null): void {
    if (!worktreeId) {
      return
    }
    const count = this.countsByWorktree.get(worktreeId) ?? 0
    if (count <= 1) {
      this.countsByWorktree.delete(worktreeId)
    } else {
      this.countsByWorktree.set(worktreeId, count - 1)
    }
  }

  /** Commit an admitted-pending record. Call ONLY from inside the coordinator's
   *  critical section, after the fingerprint recheck passed. */
  admit(input: AgentLaunchAdmitInput & { principal: AdmissionPrincipal }): AdmissionResult {
    const failure = this.capacityFailure(input.principal, input.worktreeId)
    if (failure) {
      return { ok: false, failure }
    }
    const record: AdmittedLaunchRecord = {
      launchToken: randomBytes(24).toString('base64url'),
      principal: input.principal,
      intent: input.intent,
      scope: input.scope,
      worktreeId: input.worktreeId,
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      admittedAt: input.admittedAt
    }
    this.byToken.set(record.launchToken, record)
    this.incrementCounters(input.principal)
    this.incrementWorktree(record.worktreeId)
    return { ok: true, record }
  }

  /** Take a capacity hold before git/worktree mutation. The pre-create stage
   *  reserves so a full worktree is never created for an over-cap launch. */
  reserve(principal: AdmissionPrincipal): ReservationResult {
    // A pre-create reservation names no worktree yet (it is creating one), so it
    // never counts against the per-worktree cap.
    const failure = this.capacityFailure(principal, null)
    if (failure) {
      return { ok: false, failure }
    }
    const reservationId = randomBytes(18).toString('base64url')
    this.reservations.set(reservationId, principal)
    this.incrementCounters(principal)
    return { ok: true, reservation: { reservationId, principal } }
  }

  /** Convert a held reservation into a committed record after the post-create
   *  fingerprint recheck. Counters already include the reservation, so this
   *  never re-increments. A lost/expired reservation fails closed, as does a
   *  commit into a worktree already at the per-worktree cap. */
  admitReserved(reservationId: string, input: AgentLaunchAdmitInput): AdmissionResult {
    const principal = this.reservations.get(reservationId)
    if (!principal) {
      return { ok: false, failure: { code: 'launch_capacity_exceeded', reason: 'capacity' } }
    }
    // The hold never counted against a worktree, and a retry commits into an
    // EXISTING worktree that may already be at the cap — recheck it here. The
    // reservation stays held; the caller's releaseReservation frees it.
    if (
      input.worktreeId !== null &&
      (this.countsByWorktree.get(input.worktreeId) ?? 0) >= MAX_PENDING_LAUNCHES_PER_WORKTREE
    ) {
      return { ok: false, failure: { code: 'launch_capacity_exceeded', reason: 'capacity' } }
    }
    this.reservations.delete(reservationId)
    const record: AdmittedLaunchRecord = {
      launchToken: randomBytes(24).toString('base64url'),
      principal,
      intent: input.intent,
      scope: input.scope,
      worktreeId: input.worktreeId,
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      admittedAt: input.admittedAt
    }
    this.byToken.set(record.launchToken, record)
    // The reservation already counted toward principal/host/remote; the worktree
    // slot is taken only now that it is known (post-create or retry).
    this.incrementWorktree(record.worktreeId)
    return { ok: true, record }
  }

  /** Drop a reservation that never admitted (pre-spawn exit, mismatch, or a
   *  failed post-create resolution). Frees its held capacity. */
  releaseReservation(reservationId: string): boolean {
    const principal = this.reservations.get(reservationId)
    if (!principal) {
      return false
    }
    this.reservations.delete(reservationId)
    this.decrementCounters(principal)
    return true
  }

  get(launchToken: string): AdmittedLaunchRecord | null {
    return this.byToken.get(launchToken) ?? null
  }

  /** Release on receipt (moved to terminal attribution), provider failure,
   *  admission mismatch, authoritative reconciliation, or explicit forget.
   *  Never by age while liveness is unknown. */
  release(launchToken: string): boolean {
    const record = this.byToken.get(launchToken)
    if (!record) {
      return false
    }
    this.byToken.delete(launchToken)
    this.decrementCounters(record.principal)
    this.decrementWorktree(record.worktreeId)
    return true
  }

  /** Rebuild counters from durable pending records once at startup; later
   *  transitions update counters incrementally rather than rescanning.
   *  Reservations are ephemeral pre-spawn holds and never persist, so a rebuild
   *  starts with none. */
  rebuildFrom(records: Iterable<AdmittedLaunchRecord>): void {
    this.byToken.clear()
    this.countsByPrincipal.clear()
    this.countsByWorktree.clear()
    this.reservations.clear()
    this.remoteTotal = 0
    for (const record of records) {
      this.byToken.set(record.launchToken, record)
      this.incrementCounters(record.principal)
      this.incrementWorktree(record.worktreeId)
    }
  }

  pendingCount(): number {
    return this.byToken.size
  }

  pendingForPrincipal(principal: AdmissionPrincipal): number {
    return this.countsByPrincipal.get(principalKey(principal)) ?? 0
  }

  pendingForWorktree(worktreeId: string): number {
    return this.countsByWorktree.get(worktreeId) ?? 0
  }

  /** Secret-free rows for the capacity-recovery surface: never snapshot, argv,
   *  env, prompt, label, or the token of another device's row. Ownership — not the
   *  cap bucket — filters, so a device still sees pre-device-principal rows of its
   *  own kind and never another device's. */
  summarizeFor(principal: AdmissionPrincipal): {
    intent: AgentLaunchIntentKind
    scope: string
    admittedAt: number
    launchToken: string
  }[] {
    const rows: {
      intent: AgentLaunchIntentKind
      scope: string
      admittedAt: number
      launchToken: string
    }[] = []
    for (const record of this.byToken.values()) {
      if (admissionPrincipalOwns(principal, record.principal)) {
        rows.push({
          intent: record.intent,
          scope: record.scope,
          admittedAt: record.admittedAt,
          launchToken: record.launchToken
        })
      }
    }
    return rows
  }

  /** Redacted capacity-recovery rows for one principal: the summarize set plus the
   *  two non-secret snapshot fields the sheet needs. Filters strictly to the
   *  caller's own records; never another device's row. */
  capacitySummaryFor(principal: AdmissionPrincipal): AdmissionCapacityRow[] {
    const rows: AdmissionCapacityRow[] = []
    for (const record of this.byToken.values()) {
      if (admissionPrincipalOwns(principal, record.principal)) {
        rows.push({
          intent: record.intent,
          scope: record.scope,
          admittedAt: record.admittedAt,
          launchToken: record.launchToken,
          baseHarness: record.snapshot.baseAgent,
          executionHostId: record.snapshot.target.executionHostId
        })
      }
    }
    return rows
  }
}

/** Short async critical section shared by launch admission and every mutation
 *  of admission-relevant inputs. No trust, filesystem, network, home lookup, or
 *  provider call may run while held — callers do I/O before/after, never inside. */
export class LaunchAdmissionCoordinator {
  private tail: Promise<void> = Promise.resolve()

  runExclusive<T>(critical: () => T): Promise<T> {
    const run = this.tail.then(() => critical())
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
