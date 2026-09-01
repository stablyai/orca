import { describe, expect, it } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import {
  admissionPrincipalOwns,
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator,
  MAX_PENDING_LAUNCHES_PER_HOST,
  MAX_PENDING_LAUNCHES_PER_PRINCIPAL,
  MAX_PENDING_LAUNCHES_PER_WORKTREE,
  MAX_PENDING_LAUNCHES_REMOTE_TOTAL,
  type AdmissionPrincipal
} from './agent-launch-admission-store'

const SNAPSHOT: AgentLaunchSnapshot = Object.freeze({
  version: 1,
  requestedAgent: 'codex',
  baseAgent: 'codex',
  displayLabel: 'Codex',
  mode: 'built-in',
  argv: ['codex'],
  agentEnv: {},
  target: {
    platform: 'linux',
    execution: 'native',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local'
  }
} as const) as unknown as AgentLaunchSnapshot

function admitOne(
  store: AgentLaunchAdmissionStore,
  principal: AdmissionPrincipal,
  scope = 'wt-1',
  worktreeId: string | null = null
) {
  return store.admit({
    principal,
    intent: 'interactive',
    scope,
    worktreeId,
    fingerprint: 'fp',
    snapshot: SNAPSHOT,
    admittedAt: 1
  })
}

describe('AgentLaunchAdmissionStore capacity', () => {
  it('caps each principal at 64 pending records', () => {
    const store = new AgentLaunchAdmissionStore()
    const principal: AdmissionPrincipal = { kind: 'remote', id: 'device-1' }
    for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i += 1) {
      expect(admitOne(store, principal).ok).toBe(true)
    }
    const rejected = admitOne(store, principal)
    expect(rejected).toMatchObject({
      ok: false,
      failure: { code: 'launch_capacity_exceeded', reason: 'capacity' }
    })
    // A different principal still has capacity.
    expect(admitOne(store, { kind: 'remote', id: 'device-2' }).ok).toBe(true)
  })

  it('stops remote principals collectively at 192, reserving 64 local slots', () => {
    const store = new AgentLaunchAdmissionStore()
    for (let device = 0; device < 3; device += 1) {
      for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i += 1) {
        expect(admitOne(store, { kind: 'remote', id: `device-${device}` }).ok).toBe(true)
      }
    }
    expect(store.pendingCount()).toBe(MAX_PENDING_LAUNCHES_REMOTE_TOTAL)
    expect(admitOne(store, { kind: 'remote', id: 'device-4' }).ok).toBe(false)
    // The local host retains its reserved capacity up to the host cap.
    let localAdmitted = 0
    while (admitOne(store, { kind: 'local' }).ok) {
      localAdmitted += 1
    }
    expect(localAdmitted).toBe(MAX_PENDING_LAUNCHES_PER_HOST - MAX_PENDING_LAUNCHES_REMOTE_TOTAL)
    expect(store.pendingCount()).toBe(MAX_PENDING_LAUNCHES_PER_HOST)
  })

  it('caps a single worktree at 8 committed launches, independent of other worktrees', () => {
    const store = new AgentLaunchAdmissionStore()
    const principal: AdmissionPrincipal = { kind: 'local' }
    for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_WORKTREE; i += 1) {
      expect(admitOne(store, principal, `run-${i}`, 'wt-busy').ok).toBe(true)
    }
    expect(store.pendingForWorktree('wt-busy')).toBe(MAX_PENDING_LAUNCHES_PER_WORKTREE)
    // The 9th launch into the same worktree is rejected before any provider I/O.
    expect(admitOne(store, principal, 'run-9', 'wt-busy')).toMatchObject({
      ok: false,
      failure: { code: 'launch_capacity_exceeded', reason: 'capacity' }
    })
    // A different worktree still has its own capacity.
    expect(admitOne(store, principal, 'run-other', 'wt-quiet').ok).toBe(true)
    // A launch that names no worktree never trips the per-worktree cap.
    expect(admitOne(store, principal, 'no-worktree', null).ok).toBe(true)
  })

  it('releasing a worktree launch frees exactly one per-worktree slot', () => {
    const store = new AgentLaunchAdmissionStore()
    const principal: AdmissionPrincipal = { kind: 'local' }
    const admitted = admitOne(store, principal, 'run-0', 'wt-busy')
    for (let i = 1; i < MAX_PENDING_LAUNCHES_PER_WORKTREE; i += 1) {
      admitOne(store, principal, `run-${i}`, 'wt-busy')
    }
    expect(admitOne(store, principal, 'run-9', 'wt-busy').ok).toBe(false)
    if (!admitted.ok) {
      throw new Error('fixture admit failed')
    }
    expect(store.release(admitted.record.launchToken)).toBe(true)
    expect(store.pendingForWorktree('wt-busy')).toBe(MAX_PENDING_LAUNCHES_PER_WORKTREE - 1)
    // The freed slot admits again.
    expect(admitOne(store, principal, 'run-9', 'wt-busy').ok).toBe(true)
  })

  it('rebuildFrom restores per-worktree counts from durable records', () => {
    const store = new AgentLaunchAdmissionStore()
    const a = admitOne(store, { kind: 'local' }, 'run-a', 'wt-busy')
    const b = admitOne(store, { kind: 'local' }, 'run-b', 'wt-busy')
    const c = admitOne(store, { kind: 'local' }, 'run-c', null)
    if (!a.ok || !b.ok || !c.ok) {
      throw new Error('fixture admit failed')
    }
    const rebuilt = new AgentLaunchAdmissionStore()
    rebuilt.rebuildFrom([a.record, b.record, c.record])
    expect(rebuilt.pendingForWorktree('wt-busy')).toBe(2)
  })

  it('release frees exactly one reservation and unknown tokens are no-ops', () => {
    const store = new AgentLaunchAdmissionStore()
    const admitted = admitOne(store, { kind: 'local' })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) {
      return
    }
    expect(store.release(admitted.record.launchToken)).toBe(true)
    expect(store.release(admitted.record.launchToken)).toBe(false)
    expect(store.pendingCount()).toBe(0)
    expect(store.pendingForPrincipal({ kind: 'local' })).toBe(0)
  })

  it('rebuilds counters once from durable records', () => {
    const store = new AgentLaunchAdmissionStore()
    const first = admitOne(store, { kind: 'remote', id: 'device-1' })
    const second = admitOne(store, { kind: 'local' })
    if (!first.ok || !second.ok) {
      throw new Error('fixture admit failed')
    }
    const rebuilt = new AgentLaunchAdmissionStore()
    rebuilt.rebuildFrom([first.record, second.record])
    expect(rebuilt.pendingCount()).toBe(2)
    expect(rebuilt.pendingForPrincipal({ kind: 'remote', id: 'device-1' })).toBe(1)
    expect(rebuilt.pendingForPrincipal({ kind: 'local' })).toBe(1)
  })

  it('summaries stay secret-free and principal-scoped', () => {
    const store = new AgentLaunchAdmissionStore()
    const mine = admitOne(store, { kind: 'remote', id: 'device-1' }, 'wt-42')
    admitOne(store, { kind: 'remote', id: 'device-2' }, 'wt-secret')
    expect(mine.ok).toBe(true)
    const rows = store.summarizeFor({ kind: 'remote', id: 'device-1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ intent: 'interactive', scope: 'wt-42' })
    const text = JSON.stringify(rows)
    expect(text).not.toContain('argv')
    expect(text).not.toContain('agentEnv')
    expect(text).not.toContain('wt-secret')
  })

  it('capacity rows add base harness + host id, stay principal-scoped and secret-free', () => {
    const store = new AgentLaunchAdmissionStore()
    const mine = admitOne(store, { kind: 'remote', id: 'device-1' }, 'wt-42')
    admitOne(store, { kind: 'remote', id: 'device-2' }, 'wt-secret')
    expect(mine.ok).toBe(true)
    const rows = store.capacitySummaryFor({ kind: 'remote', id: 'device-1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      intent: 'interactive',
      scope: 'wt-42',
      baseHarness: 'codex',
      executionHostId: 'local'
    })
    const text = JSON.stringify(rows)
    // Snapshot secrets never enter the row; only baseAgent + executionHostId do.
    expect(text).not.toContain('argv')
    expect(text).not.toContain('agentEnv')
    expect(text).not.toContain('displayLabel')
    expect(text).not.toContain('wt-secret')
  })
})

describe('AgentLaunchAdmissionStore reservations', () => {
  function reserveOne(store: AgentLaunchAdmissionStore, principal: AdmissionPrincipal) {
    return store.reserve(principal)
  }

  function admitReservedOne(
    store: AgentLaunchAdmissionStore,
    reservationId: string,
    scope = 'wt-1',
    worktreeId: string | null = null
  ) {
    return store.admitReserved(reservationId, {
      intent: 'interactive',
      scope,
      worktreeId,
      fingerprint: 'fp',
      snapshot: SNAPSHOT,
      admittedAt: 1
    })
  }

  it('reserve holds capacity, and admitReserved converts without double-counting', () => {
    const store = new AgentLaunchAdmissionStore()
    const reservation = reserveOne(store, { kind: 'local' })
    expect(reservation.ok).toBe(true)
    if (!reservation.ok) {
      return
    }
    // The hold counts toward the principal cap before any commit.
    expect(store.pendingForPrincipal({ kind: 'local' })).toBe(1)
    // pendingCount tracks committed records only; the hold is not committed yet.
    expect(store.pendingCount()).toBe(0)
    const admitted = admitReservedOne(store, reservation.reservation.reservationId)
    expect(admitted.ok).toBe(true)
    // Converting a hold does not re-increment: still exactly one for the principal.
    expect(store.pendingForPrincipal({ kind: 'local' })).toBe(1)
    expect(store.pendingCount()).toBe(1)
  })

  it('admitReserved commits against the now-known worktree and counts toward its cap', () => {
    const store = new AgentLaunchAdmissionStore()
    const reservation = reserveOne(store, { kind: 'local' })
    expect(reservation.ok).toBe(true)
    if (!reservation.ok) {
      return
    }
    // A reservation names no worktree, so the per-worktree count is still 0.
    expect(store.pendingForWorktree('wt-new')).toBe(0)
    const admitted = admitReservedOne(
      store,
      reservation.reservation.reservationId,
      'wt-new',
      'wt-new'
    )
    expect(admitted.ok).toBe(true)
    // Committing binds the launch to the freshly-created worktree.
    expect(store.pendingForWorktree('wt-new')).toBe(1)
  })

  it('admitReserved rejects a retry into a worktree already at the per-worktree cap', () => {
    const store = new AgentLaunchAdmissionStore()
    const principal: AdmissionPrincipal = { kind: 'local' }
    for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_WORKTREE; i += 1) {
      expect(admitOne(store, principal, `run-${i}`, 'wt-busy').ok).toBe(true)
    }
    // A retry reserves against an EXISTING worktree; the hold itself never
    // counted against the worktree, so the commit-time recheck must reject.
    const reservation = reserveOne(store, principal)
    expect(reservation.ok).toBe(true)
    if (!reservation.ok) {
      return
    }
    const admitted = admitReservedOne(
      store,
      reservation.reservation.reservationId,
      'wt-busy',
      'wt-busy'
    )
    expect(admitted).toMatchObject({
      ok: false,
      failure: { code: 'launch_capacity_exceeded', reason: 'capacity' }
    })
    expect(store.pendingForWorktree('wt-busy')).toBe(MAX_PENDING_LAUNCHES_PER_WORKTREE)
    // The rejection leaves the hold with the caller: release frees exactly one.
    expect(store.releaseReservation(reservation.reservation.reservationId)).toBe(true)
    expect(store.pendingForPrincipal(principal)).toBe(MAX_PENDING_LAUNCHES_PER_WORKTREE)
    // Freeing a committed slot lets a fresh retry into the same worktree commit.
    const released = store.release(store.capacitySummaryFor(principal)[0]?.launchToken ?? 'missing')
    expect(released).toBe(true)
    const retry = reserveOne(store, principal)
    expect(retry.ok).toBe(true)
    if (!retry.ok) {
      return
    }
    expect(admitReservedOne(store, retry.reservation.reservationId, 'wt-busy', 'wt-busy').ok).toBe(
      true
    )
  })

  it('held reservations count toward the per-principal cap', () => {
    const store = new AgentLaunchAdmissionStore()
    const principal: AdmissionPrincipal = { kind: 'remote', id: 'device-1' }
    for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i += 1) {
      expect(reserveOne(store, principal).ok).toBe(true)
    }
    // Both a further reserve and a direct admit are rejected once the holds fill.
    expect(reserveOne(store, principal).ok).toBe(false)
    expect(admitOne(store, principal).ok).toBe(false)
  })

  it('held reservations count toward the collective remote cap', () => {
    const store = new AgentLaunchAdmissionStore()
    for (let device = 0; device < 3; device += 1) {
      for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i += 1) {
        expect(reserveOne(store, { kind: 'remote', id: `device-${device}` }).ok).toBe(true)
      }
    }
    expect(reserveOne(store, { kind: 'remote', id: 'device-4' }).ok).toBe(false)
    // Local capacity is still reserved even while remote holds are maxed.
    expect(reserveOne(store, { kind: 'local' }).ok).toBe(true)
  })

  it('releaseReservation frees the held slot and unknown ids are no-ops', () => {
    const store = new AgentLaunchAdmissionStore()
    const reservation = reserveOne(store, { kind: 'local' })
    expect(reservation.ok).toBe(true)
    if (!reservation.ok) {
      return
    }
    expect(store.releaseReservation(reservation.reservation.reservationId)).toBe(true)
    expect(store.releaseReservation(reservation.reservation.reservationId)).toBe(false)
    expect(store.pendingForPrincipal({ kind: 'local' })).toBe(0)
  })

  it('admitReserved fails closed for a released or unknown reservation', () => {
    const store = new AgentLaunchAdmissionStore()
    const reservation = reserveOne(store, { kind: 'local' })
    expect(reservation.ok).toBe(true)
    if (!reservation.ok) {
      return
    }
    store.releaseReservation(reservation.reservation.reservationId)
    const admitted = admitReservedOne(store, reservation.reservation.reservationId)
    expect(admitted).toMatchObject({
      ok: false,
      failure: { code: 'launch_capacity_exceeded', reason: 'capacity' }
    })
    expect(admitReservedOne(store, 'never-issued').ok).toBe(false)
  })
})

describe('AgentLaunchAdmissionStore device-scoped principals', () => {
  const phoneA: AdmissionPrincipal = { kind: 'remote', id: 'mobile', deviceId: 'device-a' }
  const phoneB: AdmissionPrincipal = { kind: 'remote', id: 'mobile', deviceId: 'device-b' }
  // A row admitted before per-device principals landed: clientKind only.
  const legacyMobile: AdmissionPrincipal = { kind: 'remote', id: 'mobile' }

  it('gives each paired device of the same kind its own per-principal cap', () => {
    const store = new AgentLaunchAdmissionStore()
    for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i += 1) {
      expect(admitOne(store, phoneA).ok).toBe(true)
    }
    expect(admitOne(store, phoneA).ok).toBe(false)
    // The second phone is unaffected by the first phone's exhausted bucket.
    expect(store.pendingForPrincipal(phoneB)).toBe(0)
    expect(admitOne(store, phoneB).ok).toBe(true)
  })

  it('scopes capacity-recovery rows to the admitting device', () => {
    const store = new AgentLaunchAdmissionStore()
    admitOne(store, phoneA, 'wt-a')
    admitOne(store, phoneB, 'wt-b')

    expect(store.capacitySummaryFor(phoneA).map((row) => row.scope)).toEqual(['wt-a'])
    expect(store.summarizeFor(phoneB).map((row) => row.scope)).toEqual(['wt-b'])
  })

  it('keeps pre-device rows visible and claimable by any device of their kind', () => {
    const store = new AgentLaunchAdmissionStore()
    admitOne(store, legacyMobile, 'wt-legacy')

    expect(store.capacitySummaryFor(phoneA).map((row) => row.scope)).toEqual(['wt-legacy'])
    expect(admissionPrincipalOwns(phoneA, legacyMobile)).toBe(true)
    // ...but never by another client kind or the local host.
    expect(store.capacitySummaryFor({ kind: 'remote', id: 'runtime' })).toEqual([])
    expect(store.capacitySummaryFor({ kind: 'local' })).toEqual([])
  })

  it('never lets one device claim another device-scoped launch', () => {
    expect(admissionPrincipalOwns(phoneA, phoneB)).toBe(false)
    expect(admissionPrincipalOwns(phoneA, phoneA)).toBe(true)
    // A caller with no device identity cannot claim a device-scoped launch.
    expect(admissionPrincipalOwns(legacyMobile, phoneA)).toBe(false)
    // A record with no principal at all (oldest durable shape) stays forgettable.
    expect(admissionPrincipalOwns(phoneA, undefined)).toBe(true)
    expect(admissionPrincipalOwns({ kind: 'local' }, phoneA)).toBe(false)
  })

  it('rebuildFrom rehydrates legacy and device-scoped rows into separate buckets', () => {
    const store = new AgentLaunchAdmissionStore()
    const legacy = admitOne(store, legacyMobile, 'wt-legacy')
    const scoped = admitOne(store, phoneA, 'wt-a')
    if (!legacy.ok || !scoped.ok) {
      throw new Error('fixture admit failed')
    }
    store.rebuildFrom([legacy.record, scoped.record])

    expect(store.pendingCount()).toBe(2)
    expect(store.pendingForPrincipal(legacyMobile)).toBe(1)
    expect(store.pendingForPrincipal(phoneA)).toBe(1)
    expect(store.pendingForPrincipal(phoneB)).toBe(0)
  })
})

describe('LaunchAdmissionCoordinator', () => {
  it('serializes critical sections in FIFO order and survives a throwing section', async () => {
    const coordinator = new LaunchAdmissionCoordinator()
    const order: number[] = []
    const first = coordinator.runExclusive(() => {
      order.push(1)
      return 'a'
    })
    const failing = coordinator.runExclusive(() => {
      order.push(2)
      throw new Error('boom')
    })
    const third = coordinator.runExclusive(() => {
      order.push(3)
      return 'c'
    })
    await expect(first).resolves.toBe('a')
    await expect(failing).rejects.toThrow('boom')
    await expect(third).resolves.toBe('c')
    expect(order).toEqual([1, 2, 3])
  })
})
