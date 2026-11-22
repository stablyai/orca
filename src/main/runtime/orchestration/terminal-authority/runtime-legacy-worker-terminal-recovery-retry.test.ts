import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __cancelLegacyWorkerTerminalRecoveryRetriesForTests } from './runtime-legacy-worker-terminal-recovery-controller'

import { missingWorkspaceRecoveryFixture } from './structured-sessions/runtime-legacy-worker-recovery-test-fixture'

describe('RuntimeLegacyWorkerTerminalRecoveryController retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
    vi.useRealTimers()
  })

  it('resets the retry scope when an explicit pass starts after a running timer pass', async () => {
    const fixture = missingWorkspaceRecoveryFixture()
    const timerInventory = Promise.withResolvers<null>()
    const explicitInventory = Promise.withResolvers<null>()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fixture.controller.reconcile()
      fixture.refreshInventory
        .mockImplementationOnce(() => timerInventory.promise)
        .mockImplementationOnce(() => explicitInventory.promise)
      await vi.advanceTimersByTimeAsync(1_000)

      const explicitPass = fixture.controller.reconcile()
      timerInventory.resolve(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(fixture.refreshInventory).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)

      explicitInventory.resolve(null)
      await explicitPass
      await vi.advanceTimersByTimeAsync(600_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(24)
      expect(vi.getTimerCount()).toBe(1)
      expect(fixture.reconcileMissing).not.toHaveBeenCalled()
    } finally {
      timerInventory.resolve(null)
      explicitInventory.resolve(null)
      warning.mockRestore()
    }
  })
})
