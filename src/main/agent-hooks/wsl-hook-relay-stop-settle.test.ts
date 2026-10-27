import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listRunningWslDistrosAsync:
    vi.fn<(options?: { requireConfirmed?: boolean; startedAfter?: number }) => Promise<string[]>>(),
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>()
}))
vi.mock('../wsl', () => wslMocks)

import { WslRelayRecovery } from './wsl-hook-relay-recovery'
const { markWslRelayFailed } = await import('./wsl-hook-relay-state-machine')
import {
  _resetWslBackgroundDistroGateForTests,
  isWslDistroRunning,
  WSL_STOP_SETTLE_MS
} from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'

afterEach(() => {
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
})

// #34195: the relay restart must not boot a distro that WSL still lists while it is stopping.
describe('hook relay restart right after its distro stopped', () => {
  let stoppedAt = 0

  beforeEach(() => {
    // WSL keeps listing a stopping distro for a moment after the terminate.
    const probe = async (): Promise<string[]> =>
      performance.now() < stoppedAt + WSL_STOP_SETTLE_MS ? ['Ubuntu'] : []
    wslMocks.listRunningWslDistrosAsync.mockImplementation((options) =>
      resolveRunningWslDistros(probe, options)
    )
  })

  it('waits out the settle window, sees the stop, and stays down', async () => {
    const restart = vi.fn()
    const dropState = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: (distro, startedAfter) => isWslDistroRunning(distro, { startedAfter }),
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState
    })
    const state = { distro: 'Ubuntu', phase: 'running' as const, failures: 0, cooldownUntil: 0 }
    stoppedAt = performance.now()
    markWslRelayFailed(
      state,
      'relay link mux disposed',
      { cooldownBaseMs: 0 },
      { warn: vi.fn() },
      recovery
    )
    // An explorer read inside the settle window still sees the distro listed.
    await expect(isWslDistroRunning('Ubuntu')).resolves.toBe(false)
    await vi.waitFor(() => expect(dropState).toHaveBeenCalledOnce(), { timeout: 3_000 })
    expect(restart).not.toHaveBeenCalled()
  })
})
