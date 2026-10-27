import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WslRelayRecovery, type WslRelayRecoveryState } from './wsl-hook-relay-recovery'
import type { WslRelayDistroState, WslRelayRestartSetup } from './wsl-hook-relay-state'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'
import {
  captureWslRelaySetup,
  markWslRelayFailed,
  restartWslRelay
} from './wsl-hook-relay-state-machine'

const { noteWslDistroMayHaveStoppedMock } = vi.hoisted(() => ({
  noteWslDistroMayHaveStoppedMock: vi.fn()
}))
vi.mock('../wsl/wsl-unc-access-gate', () => ({
  noteWslDistroMayHaveStopped: noteWslDistroMayHaveStoppedMock
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
  it('re-ensures the distro when the restart timer fires and the distro is running', async () => {
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => restart.mock.calls.length === 1)
    expect(restart).toHaveBeenCalledWith('Ubuntu', { launchKinds: [] })
  })

  it('drops the state instead of booting a stopped distro', async () => {
    const restart = vi.fn()
    const dropState = vi.fn()
    const warn = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => false,
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn,
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => dropState.mock.calls.length === 1)
    expect(restart).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('distro not running'))
  })

  it('after a terminate, stays down and comes back only once the distro runs again (E9)', async () => {
    const restart = vi.fn()
    const dropState = vi.fn()
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
      dropState
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => dropState.mock.calls.length === 1)
    expect(restart).not.toHaveBeenCalled()
    expect(deferred).toHaveLength(1)
    // Something else (the user) started the distro: only now does the relay come back.
    deferred[0]()
    expect(restart).toHaveBeenCalledExactlyOnceWith('Ubuntu', { launchKinds: [] })
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
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => false,
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
    deferred[0]()
    expect(restart).toHaveBeenCalledExactlyOnceWith('Ubuntu', expected)
  })

  it('accepts only a running-list read started at check time, not one begun at the terminate', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    const isDistroRunning = vi.fn(async (_distro: string, _startedAfter: number) => false)
    const recovery = new WslRelayRecovery({
      isDistroRunning,
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart: vi.fn(),
      dropState: vi.fn()
    })
    recovery.scheduleRestart(makeState())
    // A read begun just after the terminate may still list the distro; the check runs later.
    now.mockReturnValue(11_000)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => isDistroRunning.mock.calls.length === 1)
    expect(isDistroRunning.mock.calls[0]?.[1]).toBe(11_000)
    now.mockRestore()
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

  it('does nothing when the state was replaced before the restart probe', async () => {
    const restart = vi.fn()
    const probe = vi.fn(async () => true)
    const recovery = new WslRelayRecovery({
      isDistroRunning: probe,
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => false,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(500)
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
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => current,
      restart,
      dropState
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => probe.mock.calls.length === 1)
    current = false
    resolveProbe?.(false)
    await vi.advanceTimersByTimeAsync(100)
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
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => current,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => probe.mock.calls.length === 1)
    current = false
    resolveProbe?.(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(restart).not.toHaveBeenCalled()
  })

  it('scheduleOneShotReinstall is a no-op once disposed', async () => {
    const run = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
      warn: vi.fn(),
      isDisposed: () => true,
      isCurrent: () => true,
      restart: vi.fn(),
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleOneShotReinstall(state, 10, run)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).not.toHaveBeenCalled()
    expect(state.reinstallTimer).toBeUndefined()
  })

  it('clearTimers cancels both pending timers', async () => {
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      deferUntilRunning: vi.fn(),
      captureSetup: () => ({ launchKinds: [] }),
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
    await vi.advanceTimersByTimeAsync(500)
    expect(restart).not.toHaveBeenCalled()
    expect(reinstall).not.toHaveBeenCalled()
    expect(state.restartTimer).toBeUndefined()
    expect(state.reinstallTimer).toBeUndefined()
  })
})

describe('restartWslRelay', () => {
  function relayState(overrides: Partial<WslRelayDistroState> = {}): WslRelayDistroState {
    return {
      distro: 'Ubuntu',
      phase: 'running',
      failures: 0,
      cooldownUntil: 0,
      launchKinds: new Set(),
      ...overrides
    }
  }

  it('seeds a dropped relay so ensure inherits every captured config field', async () => {
    const states = new Map<string, WslRelayDistroState>()
    const key = wslHookRelayStateKey('Ubuntu')
    const source = relayState({
      codexHomePath: '/h',
      claudeAgentViewDir: '/av',
      claudeConfigDir: '/cc',
      opencodeOverlayDir: '/oc',
      opencode2OverlayDir: '/oc2',
      piAgentDir: '/pi',
      ompStatusExtension: '/omp',
      launchKinds: new Set(['pi', 'omp'])
    })
    const setup = captureWslRelaySetup(source)
    const seen: (WslRelayDistroState | undefined)[] = []
    const ensure = vi.fn(async () => {
      seen.push(states.get(key))
      states.set(key, relayState({ ...states.get(key), phase: 'starting' }))
    })
    await restartWslRelay(states, ensure, 'Ubuntu', setup)
    const { phase: _p, ...expectedConfig } = source
    expect(seen[0]).toMatchObject({ ...expectedConfig, phase: 'failed', cooldownUntil: 0 })
    expect(ensure.mock.calls).toEqual([
      ['Ubuntu'],
      ['Ubuntu', undefined, 'pi'],
      ['Ubuntu', undefined, 'omp']
    ])
  })

  it('removes the seed when ensure bails without replacing it', async () => {
    const states = new Map<string, WslRelayDistroState>()
    await restartWslRelay(
      states,
      vi.fn(async () => {}),
      'Ubuntu',
      { codexHomePath: '/h', launchKinds: [] }
    )
    expect(states.size).toBe(0)
  })

  it('leaves a relay a terminal already re-ensured in place', async () => {
    const live = relayState({ codexHomePath: '/new' })
    const states = new Map([[wslHookRelayStateKey('Ubuntu'), live]])
    const ensure = vi.fn(async () => {})
    await restartWslRelay(states, ensure, 'Ubuntu', { codexHomePath: '/old', launchKinds: ['pi'] })
    expect(states.get(wslHookRelayStateKey('Ubuntu'))).toBe(live)
    expect(live.codexHomePath).toBe('/new')
    expect(ensure.mock.calls).toEqual([['Ubuntu'], ['Ubuntu', undefined, 'pi']])
  })
})

describe('markWslRelayFailed', () => {
  it('marks the distro as possibly stopped so the next UNC read re-checks before touching it', () => {
    const scheduleRestart = vi.fn()
    markWslRelayFailed(
      { distro: 'Ubuntu', phase: 'running', failures: 0, cooldownUntil: 0 },
      'relay link mux disposed (connection_lost)',
      { cooldownBaseMs: 1_000 },
      { warn: vi.fn() },
      { scheduleRestart }
    )
    expect(noteWslDistroMayHaveStoppedMock).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    expect(scheduleRestart).toHaveBeenCalledOnce()
  })
})
