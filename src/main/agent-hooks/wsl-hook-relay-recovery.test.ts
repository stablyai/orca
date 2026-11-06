import type * as WslBackgroundDistroGate from '../wsl/discovery/wsl-background-distro-gate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WslRelayRecovery, type WslRelayRecoveryState } from './wsl-hook-relay-recovery'
import type { WslRelayRestartSetup } from './wsl-hook-relay-state'

const { noteWslDistroMayHaveStoppedMock } = vi.hoisted(() => ({
  noteWslDistroMayHaveStoppedMock: vi.fn()
}))
vi.mock('../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslBackgroundDistroGate>()),
  ...(await (() => ({
    noteWslDistroMayHaveStopped: noteWslDistroMayHaveStoppedMock
  }))())
}))

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))

afterEach(() => vi.useRealTimers())

function makeState(): WslRelayRecoveryState {
  return { distro: 'Ubuntu', cooldownUntil: Date.now() - 1_000 }
}

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  return vi.waitFor(() => expect(condition()).toBe(true), { timeout: timeoutMs })
}

describe('WslRelayRecovery', () => {
  it('re-reads a settled list before a drained restart, and waits again if the distro stopped', async () => {
    const restart = vi.fn()
    const deferred: (() => void)[] = []
    const isDistroRunning = vi.fn(async (_distro: string, _startedAfter: number) => false)
    const recovery = new WslRelayRecovery({
      isDistroRunning,
      deferUntilRunning: (_distro, task) => deferred.push(task),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    recovery.scheduleRestart(makeState())
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => deferred.length === 1)

    // Drained by a list that still named the stopping distro; a fresh settled read says stopped.
    deferred[0]()
    await waitFor(() => deferred.length === 2)
    expect(restart).not.toHaveBeenCalled()

    isDistroRunning.mockResolvedValue(true)
    deferred[1]()
    await waitFor(() => restart.mock.calls.length === 1)
  })

  it('restarts with the relay config captured before dropState discarded it', async () => {
    const restart = vi.fn()
    const deferred: (() => void)[] = []
    let live: WslRelayRestartSetup | undefined = {
      codexHomePath: '/home/u/.orca-codex',
      claudeConfigDir: '/home/u/.orca/claude',
      launchKinds: ['pi', 'omp']
    }
    const expected = live
    const isDistroRunning = vi.fn(async (_distro: string, _startedAfter: number) => false)
    const recovery = new WslRelayRecovery({
      isDistroRunning,
      deferUntilRunning: (_distro, task) => deferred.push(task),
      captureSetup: () => live ?? { launchKinds: [] },
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: () => {
        live = undefined
      }
    })
    recovery.scheduleRestart(makeState())
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => deferred.length === 1)
    isDistroRunning.mockResolvedValue(true)
    deferred[0]()
    await waitFor(() => restart.mock.calls.length === 1)
    expect(restart).toHaveBeenCalledExactlyOnceWith('Ubuntu', expected)
  })

  it('re-probes once after a stopped verdict and restarts only once', async () => {
    const restart = vi.fn()
    const deferred: (() => void)[] = []
    const isDistroRunning = vi.fn(async () => false)
    const recovery = new WslRelayRecovery({
      isDistroRunning,
      deferUntilRunning: (_distro, task) => deferred.push(task),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    recovery.scheduleRestart(makeState())
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => deferred.length === 1)
    // The first read was wrong (the distro was still running): the re-probe recovers it.
    isDistroRunning.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(30_000)
    await waitFor(() => restart.mock.calls.length === 1)
    deferred[0]()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(isDistroRunning).toHaveBeenCalledTimes(2)
    expect(restart).toHaveBeenCalledTimes(1)
  })
})
