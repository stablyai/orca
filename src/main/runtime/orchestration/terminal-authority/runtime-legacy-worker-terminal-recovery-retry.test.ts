import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __cancelLegacyWorkerTerminalRecoveryRetriesForTests } from './runtime-legacy-worker-terminal-recovery-controller'

import {
  missingWorkspaceRecoveryFixture,
  missingWorkspaceWorker
} from './structured-sessions/runtime-legacy-worker-recovery-test-fixture'

import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'

describe('RuntimeLegacyWorkerTerminalRecoveryController retry loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
    vi.useRealTimers()
  })

  it('keeps every host timer cancellable after extended recovery', async () => {
    const local = missingWorkspaceWorker()
    const remote = missingWorkspaceWorker({
      dispatchId: 'dispatch-remote',
      ptyId: toAppSshPtyId('server-1', 'pty-remote')
    })
    const fixture = missingWorkspaceRecoveryFixture([local, remote])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fixture.controller.reconcile()
      await vi.advanceTimersByTimeAsync(31_000)
      await fixture.controller.reconcile({ connectionId: 'server-1' })
      await vi.advanceTimersByTimeAsync(30_000)
      const callsBeforeCancellation = fixture.reconcile.mock.calls.length
      expect(vi.getTimerCount()).toBe(2)

      __cancelLegacyWorkerTerminalRecoveryRetriesForTests()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fixture.reconcile).toHaveBeenCalledTimes(callsBeforeCancellation)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      warning.mockRestore()
    }
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
