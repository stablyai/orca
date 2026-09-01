// Revoked-principal forget override (§U9 / plan :498): the LOCAL desktop owner may
// forget a stranded worktree launch ONLY when its owning remote principal is
// EXPLICITLY REVOKED — no paired device of that scope remains in the pairing store
// (checked against the store, not connection liveness) — and it owns the row on a
// disconnected remote provider. It routes through the same single-forget reconciler
// as the owner-facing forget, and can never clear an active paired device's, the
// local host's, or an unowned reservation. The reconciler is mocked here (its guards
// are exercised in agent-launch-worktree-forget's own suite); these tests pin the
// added REVOCATION gate and the principal the forget is namespaced under.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { agentLaunchIdempotencyKey } from '../agent-launch/agent-launch-operation-store'
import type { AdmissionCapacityRow } from '../agent-launch/agent-launch-admission-store'
import type { ForgetUnknownAgentLaunchDeps } from '../agent-launch/agent-launch-worktree-forget'
import type { DeviceScope } from '../../shared/runtime-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const capacityMock = vi.fn<(principal: unknown) => AdmissionCapacityRow[]>()

vi.mock('../agent-launch/agent-launch-boundary-host', () => ({
  getHostAgentLaunchBoundary: () => ({ capacitySummaryFor: capacityMock })
}))

// Spy the shared reconciler: capture its injected deps + params without running the
// real settle so these tests isolate the override's revocation gate.
const forgetSpy = vi.fn(
  (_deps: ForgetUnknownAgentLaunchDeps, _params: unknown) => ({ status: 'forgotten' }) as const
)
vi.mock('../agent-launch/agent-launch-worktree-forget', () => ({
  runForgetUnknownAgentLaunch: (deps: ForgetUnknownAgentLaunchDeps, params: unknown) =>
    forgetSpy(deps, params)
}))

vi.mock('../agent-launch/agent-launch-operation-store-host', () => ({
  getHostAgentLaunchOperationStore: () => ({
    findPendingByScope: () => null,
    recordSettled: () => {},
    clearPending: () => true,
    settleAndClearPending: () => {}
  })
}))

function row(over: Partial<AdmissionCapacityRow>): AdmissionCapacityRow {
  return {
    intent: 'interactive',
    scope: 'wt-1',
    admittedAt: 1,
    launchToken: 'tok',
    baseHarness: 'codex',
    executionHostId: 'ssh:prod',
    ...over
  }
}

function stubRuntime(
  rows: AdmissionCapacityRow[],
  pairedScopes: DeviceScope[]
): OrcaRuntimeService {
  capacityMock.mockReturnValue(rows)
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as {
    store: unknown
    getPairedDeviceScopesFn: () => readonly DeviceScope[]
    notifyWorktreesChanged: (repoId: string) => void
    listResolvedWorktrees: () => Promise<{ id: string; repoId: string; path: string }[]>
  }
  internals.store = {
    // Only the fixture repo id resolves; a truthy return for a bare worktree id
    // would trip the repo-id-collision selector guard.
    getRepo: (id: string) => (id === 'repo-1' ? { id } : undefined),
    getWorktreeMeta: () => ({ agentLaunchFailure: { code: 'launch_state_unknown' } }),
    setWorktreeMeta: () => {}
  }
  internals.getPairedDeviceScopesFn = () => pairedScopes
  internals.notifyWorktreesChanged = () => {}
  // Every scope in the capacity rows (plus an orphan) resolves to a worktree.
  internals.listResolvedWorktrees = async () =>
    [...rows.map((r) => r.scope), 'wt-orphan'].map((scope) => ({
      id: scope,
      repoId: 'repo-1',
      path: `/wt/${scope}`
    }))
  return runtime
}

const FORGET_ARGS = { expectedOperationId: 'op-1', clientMutationId: 'cmid-1' }

describe('forgetRevokedRemoteWorktreeAgentLaunch', () => {
  beforeEach(() => {
    forgetSpy.mockClear()
    // Drop any per-test mockImplementation; stubRuntime re-sets the return value.
    capacityMock.mockReset()
  })

  it('forgets a row whose owning mobile principal is revoked, under that principal', async () => {
    // mobile has no paired device (revoked); runtime is still paired.
    const runtime = stubRuntime([row({ scope: 'wt-mobile' })], ['runtime'])

    const result = await runtime.forgetRevokedRemoteWorktreeAgentLaunch('id:wt-mobile', FORGET_ARGS)

    expect(result).toEqual({ status: 'forgotten' })
    const [deps, params] = forgetSpy.mock.calls[0]
    expect(params).toMatchObject({
      scope: 'wt-mobile',
      expectedOperationId: 'op-1',
      clientMutationId: 'cmid-1'
    })
    // The forget is namespaced under the REVOKED remote principal, not the local caller.
    expect(deps.idempotencyKeyFor('probe')).toBe(
      agentLaunchIdempotencyKey({
        principal: { kind: 'remote', id: 'mobile' },
        scope: 'wt-mobile',
        clientMutationId: 'probe'
      })
    )
  })

  it('never forgets an ACTIVE paired device’s row (revocation gate, not liveness)', async () => {
    // Both kinds still paired: the row is disconnected but its owner is NOT revoked.
    const runtime = stubRuntime([row({ scope: 'wt-mobile' })], ['mobile', 'runtime'])

    const result = await runtime.forgetRevokedRemoteWorktreeAgentLaunch('id:wt-mobile', FORGET_ARGS)

    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(forgetSpy).not.toHaveBeenCalled()
  })

  it('never forgets a LOCAL-host reservation, even with all remotes revoked', async () => {
    const runtime = stubRuntime([row({ scope: 'wt-local', executionHostId: 'local' })], [])

    const result = await runtime.forgetRevokedRemoteWorktreeAgentLaunch('id:wt-local', FORGET_ARGS)

    expect(result.status).toBe('rejected')
    expect(forgetSpy).not.toHaveBeenCalled()
  })

  it('selects the correct revoked kind and is not shadowed by a still-paired kind', async () => {
    // mobile still paired; runtime revoked and owns the row.
    const runtime = stubRuntime([row({ scope: 'wt-runtime' })], ['mobile'])

    const result = await runtime.forgetRevokedRemoteWorktreeAgentLaunch(
      'id:wt-runtime',
      FORGET_ARGS
    )

    expect(result).toEqual({ status: 'forgotten' })
    const [deps] = forgetSpy.mock.calls[0]
    expect(deps.idempotencyKeyFor('probe')).toBe(
      agentLaunchIdempotencyKey({
        principal: { kind: 'remote', id: 'runtime' },
        scope: 'wt-runtime',
        clientMutationId: 'probe'
      })
    )
  })

  it('re-gates revocation on EVERY row: a device reconnecting mid-sequence blocks the next row', async () => {
    // Two stranded mobile-owned rows; the paired set is read live per call.
    const rows = [row({ scope: 'wt-row1' }), row({ scope: 'wt-row2' })]
    const runtime = stubRuntime(rows, [])
    let pairedNow: DeviceScope[] = []
    const internals = runtime as unknown as {
      getPairedDeviceScopesFn: () => readonly DeviceScope[]
    }
    internals.getPairedDeviceScopesFn = () => pairedNow
    // Faithful ownership: both rows belong to the mobile principal only, so the
    // runtime principal's capacity view is empty (unlike the shared-rows default).
    capacityMock.mockImplementation((principal) =>
      (principal as { id?: string }).id === 'mobile' ? rows : []
    )

    // Row 1: mobile revoked (no paired device) -> forgotten.
    const first = await runtime.forgetRevokedRemoteWorktreeAgentLaunch('id:wt-row1', FORGET_ARGS)
    expect(first).toEqual({ status: 'forgotten' })

    // A mobile device reconnects between rows: the principal is no longer revoked.
    pairedNow = ['mobile']

    // Row 2: the SAME sequence, but the live re-gate now blocks it (not a stale
    // dialog-open snapshot) -> rejected, and the reconciler runs only for row 1.
    const second = await runtime.forgetRevokedRemoteWorktreeAgentLaunch('id:wt-row2', FORGET_ARGS)
    expect(second).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(forgetSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects when no revoked remote principal owns the row', async () => {
    // All remotes revoked, but the addressed worktree appears in no capacity row.
    const runtime = stubRuntime([row({ scope: 'wt-mobile' })], [])

    const result = await runtime.forgetRevokedRemoteWorktreeAgentLaunch('id:wt-orphan', FORGET_ARGS)

    expect(result.status).toBe('rejected')
    expect(forgetSpy).not.toHaveBeenCalled()
  })
})
