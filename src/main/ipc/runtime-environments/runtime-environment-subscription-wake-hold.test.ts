// A stream (tabs, statuses) opened while the recipe VM is already waking waits for that wake, as a
// call does, instead of being refused at once and left to the renderer's backoff (a slow wake then
// left the woken pane dead).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ENVIRONMENT = { id: 'env-vm', pairingRevision: 1, createdAt: 0 }
const wake = vi.hoisted(() => ({
  awaitInFlight: vi.fn(async () => null),
  prepare: vi.fn(async () => ({ wokenPairingRevision: null }))
}))

vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: () => ENVIRONMENT
}))
vi.mock('../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind', () => ({
  classifyRuntimeEnvironmentHost: () => ({ kind: 'paired' })
}))
vi.mock('../../wsl/host-lifecycle/wsl-host-gate', () => ({ assertWslHostReachable: () => {} }))
vi.mock('./runtime-environment-recipe-vm-wake', () => ({
  RECIPE_VM_IN_FLIGHT_WAKE_HOLD_MS: 60_000,
  awaitRecipeVmInFlightWake: wake.awaitInFlight,
  prepareRecipeVm: wake.prepare
}))

import { resolveSubscribedRuntimeEnvironment } from './runtime-environment-managed-tunnel'

describe('a subscription opened while the VM wakes', () => {
  beforeEach(() => {
    wake.awaitInFlight.mockClear()
    wake.prepare.mockClear()
  })

  it('waits for the in-flight wake (the in-flight maximum, or less if its caller says so) first', async () => {
    await resolveSubscribedRuntimeEnvironment(
      '/user-data',
      'env-vm',
      undefined,
      'session.tabs.subscribe'
    )
    expect(wake.awaitInFlight).toHaveBeenCalledWith('/user-data', ENVIRONMENT, 60_000, undefined)
    expect(wake.awaitInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      wake.prepare.mock.invocationCallOrder[0]!
    )
    await resolveSubscribedRuntimeEnvironment(
      '/user-data',
      'env-vm',
      { recipeVmHoldMs: 2_000 },
      'session.tabs.subscribe'
    )
    expect(wake.awaitInFlight).toHaveBeenLastCalledWith('/user-data', ENVIRONMENT, 2_000, undefined)
  })

  it('does not hold a stream that opens the workspace (that one wakes it in its own preparation)', async () => {
    await resolveSubscribedRuntimeEnvironment(
      '/user-data',
      'env-vm',
      undefined,
      'worktree.activate'
    )
    expect(wake.awaitInFlight).not.toHaveBeenCalled()
    expect(wake.prepare).toHaveBeenCalled()
  })
})
