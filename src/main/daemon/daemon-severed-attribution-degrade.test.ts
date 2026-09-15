import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  inProcessProvider,
  degradedInstances,
  isDaemonRestartInFlightMock,
  getDaemonProviderMock,
  getLocalPtyProviderMock,
  replaceDaemonProviderMock,
  rebindLocalProviderListenersMock,
  checkDaemonHealthMock,
  getMacDaemonTccAttributionHealthMock
} = vi.hoisted(() => {
  const inProcessProvider = { kind: 'in-process' }
  const degradedInstances: {
    opts: Record<string, unknown>
    discover: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }[] = []
  return {
    inProcessProvider,
    degradedInstances,
    isDaemonRestartInFlightMock: vi.fn(() => false),
    getDaemonProviderMock: vi.fn<() => unknown>(),
    getLocalPtyProviderMock: vi.fn<() => unknown>(),
    replaceDaemonProviderMock: vi.fn(),
    rebindLocalProviderListenersMock: vi.fn(),
    checkDaemonHealthMock: vi.fn(async () => 'healthy'),
    getMacDaemonTccAttributionHealthMock: vi.fn(async () => 'intact')
  }
})

vi.mock('../ipc/pty', () => ({
  getInProcessPtyProvider: () => inProcessProvider,
  // Why the installed provider here: this is what the real registry answers after install, and
  // what the degraded fallback must never be.
  getLocalPtyProvider: getLocalPtyProviderMock,
  rebindLocalProviderListeners: rebindLocalProviderListenersMock
}))
vi.mock('./daemon-restart-state', () => ({ isDaemonRestartInFlight: isDaemonRestartInFlightMock }))
vi.mock('./daemon-provider-state', () => ({
  getDaemonProvider: getDaemonProviderMock,
  replaceDaemonProvider: replaceDaemonProviderMock
}))
vi.mock('./daemon-launch-paths', () => ({ getDaemonRuntimeDir: () => '/runtime' }))
vi.mock('./daemon-spawner', () => ({
  getDaemonSocketPath: (dir: string) => `${dir}/daemon.sock`,
  getDaemonTokenPath: (dir: string) => `${dir}/token`
}))
vi.mock('./daemon-health', () => ({ checkDaemonHealth: checkDaemonHealthMock }))
vi.mock('./daemon-tcc-attribution', () => ({
  getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
}))
vi.mock('./daemon-pty-router', () => ({ DaemonPtyRouter: class DaemonPtyRouter {} }))
vi.mock('./degraded-daemon-pty-provider', () => ({
  DegradedDaemonPtyProvider: class DegradedDaemonPtyProvider {
    discoverDaemonSessions = vi.fn(async () => {})
    disposeProviderOnly = vi.fn()
    constructor(public opts: Record<string, unknown>) {
      degradedInstances.push({
        opts,
        discover: this.discoverDaemonSessions,
        dispose: this.disposeProviderOnly
      })
    }
  }
}))

import {
  createSeveredDaemonRecoveryProbe,
  degradeInstalledProviderForSeveredDaemon
} from './daemon-severed-attribution-degrade'
import { DaemonPtyAdapter } from './daemon-pty-adapter'

const installedAdapter = new DaemonPtyAdapter({
  socketPath: '/runtime/daemon.sock',
  tokenPath: '/runtime/token'
})

beforeEach(() => {
  degradedInstances.length = 0
  vi.clearAllMocks()
  isDaemonRestartInFlightMock.mockReturnValue(false)
  getDaemonProviderMock.mockReturnValue(installedAdapter)
  getLocalPtyProviderMock.mockReturnValue(installedAdapter)
  checkDaemonHealthMock.mockResolvedValue('healthy')
  getMacDaemonTccAttributionHealthMock.mockResolvedValue('intact')
})

describe('degradeInstalledProviderForSeveredDaemon', () => {
  it.each(['restart', 'replacement', 'shutdown'])(
    'disposes the candidate when %s wins discovery',
    async (winner) => {
      const pending = degradeInstalledProviderForSeveredDaemon(installedAdapter)
      if (winner === 'restart') {
        isDaemonRestartInFlightMock.mockReturnValue(true)
      } else {
        getDaemonProviderMock.mockReturnValue(winner === 'shutdown' ? null : {})
      }
      await expect(pending).resolves.toBe(false)
      expect(degradedInstances[0].dispose).toHaveBeenCalledOnce()
      expect(replaceDaemonProviderMock).not.toHaveBeenCalled()
    }
  )
  it('hands the degraded provider the in-process fallback, never the installed daemon topology', async () => {
    // Regression: asking the registry for the "local provider" after install returns the daemon
    // adapter itself, so degraded mode routed fresh terminals straight back onto the severed daemon.
    await expect(degradeInstalledProviderForSeveredDaemon(installedAdapter)).resolves.toBe(true)

    expect(degradedInstances).toHaveLength(1)
    const [degraded] = degradedInstances
    expect(degraded.opts.fallback).toBe(inProcessProvider)
    expect(degraded.opts.fallback).not.toBe(installedAdapter)
    expect(degraded.opts.current).toBe(installedAdapter)
    expect(degraded.opts.legacy).toEqual([])
    expect(replaceDaemonProviderMock).toHaveBeenCalledTimes(1)
    expect(rebindLocalProviderListenersMock).toHaveBeenCalledTimes(1)
    // Routes for the daemon's live sessions must exist before the swap makes the provider live.
    expect(degraded.discover.mock.invocationCallOrder[0]).toBeLessThan(
      replaceDaemonProviderMock.mock.invocationCallOrder[0]
    )
  })

  it('declines while a daemon restart is in flight', async () => {
    isDaemonRestartInFlightMock.mockReturnValue(true)

    await expect(degradeInstalledProviderForSeveredDaemon(installedAdapter)).resolves.toBe(false)

    expect(degradedInstances).toHaveLength(0)
    expect(replaceDaemonProviderMock).not.toHaveBeenCalled()
    expect(rebindLocalProviderListenersMock).not.toHaveBeenCalled()
  })

  it('declines when the reporting adapter is no longer the installed one', async () => {
    getDaemonProviderMock.mockReturnValue({ kind: 'replacement-adapter' })

    await expect(degradeInstalledProviderForSeveredDaemon(installedAdapter)).resolves.toBe(false)

    expect(degradedInstances).toHaveLength(0)
    expect(replaceDaemonProviderMock).not.toHaveBeenCalled()
  })
})

describe('createSeveredDaemonRecoveryProbe', () => {
  const probe = () =>
    createSeveredDaemonRecoveryProbe('/runtime', '/runtime/daemon.sock', '/runtime/token')

  it('recovers only when the daemon is healthy and attribution is intact', async () => {
    await expect(probe()()).resolves.toBe(true)

    getMacDaemonTccAttributionHealthMock.mockResolvedValue('severed')
    await expect(probe()()).resolves.toBe(false)
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
    await expect(probe()()).resolves.toBe(process.platform !== 'darwin')
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('at-risk')
    await expect(probe()()).resolves.toBe(false)
  })

  it('does not consult attribution for an unhealthy daemon', async () => {
    checkDaemonHealthMock.mockResolvedValue('unreachable')

    await expect(probe()()).resolves.toBe(false)
    expect(getMacDaemonTccAttributionHealthMock).not.toHaveBeenCalled()
  })
})
