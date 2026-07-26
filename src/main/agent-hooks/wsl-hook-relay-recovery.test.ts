// Restart-timer policy: recovery must re-ensure a running distro, must NOT
// boot a stopped one (wsl -d starts stopped distros), and must respect state
// currency and disposal.
import { describe, expect, it, vi } from 'vitest'

import { WslRelayRecovery, type WslRelayRecoveryState } from './wsl-hook-relay-recovery'

function makeState(): WslRelayRecoveryState {
  return { distro: 'Ubuntu', cooldownUntil: Date.now() - 1_000 }
}

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  return vi.waitFor(() => expect(condition()).toBe(true), { timeout: timeoutMs })
}

describe('WslRelayRecovery', () => {
  it('re-ensures the distro when the restart timer fires and the distro is running', async () => {
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await waitFor(() => restart.mock.calls.length === 1)
    expect(restart).toHaveBeenCalledWith('Ubuntu')
  })

  it('drops the state instead of booting a stopped distro', async () => {
    const restart = vi.fn()
    const dropState = vi.fn()
    const warn = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => false,
      warn,
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await waitFor(() => dropState.mock.calls.length === 1)
    expect(restart).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('distro not running'))
  })

  it('does nothing when the state was replaced or the manager is disposed', async () => {
    const restart = vi.fn()
    const probe = vi.fn(async () => true)
    const recovery = new WslRelayRecovery({
      isDistroRunning: probe,
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => false,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(probe).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not drop or restart when the state was replaced mid-probe (probe false)', async () => {
    let current = true
    let resolveProbe: ((running: boolean) => void) | undefined
    const probe = vi.fn(() => new Promise<boolean>((resolve) => (resolveProbe = resolve)))
    const restart = vi.fn()
    const dropState = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: probe,
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => current,
      restart,
      dropState
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await waitFor(() => probe.mock.calls.length === 1)
    // A fresh ensure() replaces this state while the probe is in flight.
    current = false
    resolveProbe?.(false)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dropState).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not restart when the state was replaced mid-probe (probe true)', async () => {
    let current = true
    let resolveProbe: ((running: boolean) => void) | undefined
    const probe = vi.fn(() => new Promise<boolean>((resolve) => (resolveProbe = resolve)))
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: probe,
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => current,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await waitFor(() => probe.mock.calls.length === 1)
    current = false
    resolveProbe?.(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(restart).not.toHaveBeenCalled()
  })

  it('scheduleOneShotReinstall is a no-op once disposed', async () => {
    const run = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      warn: vi.fn(),
      isDisposed: () => true,
      isCurrent: () => true,
      restart: vi.fn(),
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleOneShotReinstall(state, 10, run)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(run).not.toHaveBeenCalled()
    expect(state.reinstallTimer).toBeUndefined()
  })

  it('clearTimers cancels both pending timers', async () => {
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    const reinstall = vi.fn()
    recovery.scheduleRestart(state)
    recovery.scheduleOneShotReinstall(state, 100, reinstall)
    recovery.clearTimers(state)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(restart).not.toHaveBeenCalled()
    expect(reinstall).not.toHaveBeenCalled()
    expect(state.restartTimer).toBeUndefined()
    expect(state.reinstallTimer).toBeUndefined()
  })
})
