import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacDaemonLaunchd from './macos-daemon-launchd'
import type { DaemonLauncher } from './daemon-spawner'
import { LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS } from '../startup/first-window-startup-services'
import { DAEMON_CHILD_STARTUP_TIMEOUT_MS } from './daemon-launched-child'

const {
  stableLaunch,
  retireMock,
  materializeMock,
  forkMock,
  isPackagedMock,
  getAppPathMock,
  checkDaemonHealthMock,
  spawnerInstances,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () => {
  const stableLaunch: {
    /** `disabled` is the rollback: the stable launcher returns null and never copies. */
    failure: 'unavailable' | 'fatal' | 'disabled' | 'real'
    deadlinesMs: number[]
    /** Where the clock stands, relative to the handoff deadline, when the attempt fails. */
    failAtDeadlineOffsetMs: number | null
  } = { failure: 'unavailable', deadlinesMs: [], failAtDeadlineOffsetMs: null }
  return {
    stableLaunch,
    retireMock: vi.fn(async (_root: string) => {}),
    materializeMock: vi.fn(),
    ...(await (await import('./daemon-init-test-harness')).createDaemonInitMocks())
  }
})

vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./macos-daemon-launchd', async (importOriginal) => {
  const actual = await importOriginal<typeof MacDaemonLaunchd>()
  return {
    ...actual,
    launchMacDaemonFromStableBundle: async (
      options: Parameters<typeof actual.launchMacDaemonFromStableBundle>[0],
      deadlineMs: number
    ) => {
      stableLaunch.deadlinesMs.push(deadlineMs)
      if (stableLaunch.failure === 'real') {
        return actual.launchMacDaemonFromStableBundle(options, deadlineMs)
      }
      if (stableLaunch.failAtDeadlineOffsetMs !== null) {
        const failedAtMs = deadlineMs + stableLaunch.failAtDeadlineOffsetMs
        vi.spyOn(Date, 'now').mockReturnValue(failedAtMs)
      }
      if (stableLaunch.failure === 'disabled') {
        return null
      }
      throw stableLaunch.failure === 'unavailable'
        ? new actual.MacDaemonStableLaunchUnavailableError('Could not prepare the runtime')
        : new Error('Could not start the macOS terminal service')
    }
  }
})

vi.mock('./macos-daemon-bundle', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeMacDaemonBundle: materializeMock
}))

vi.mock('./macos-daemon-bundle-retirement', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  retireAbandonedMacDaemonBundles: retireMock
}))

function isDaemonLauncher(value: unknown): value is DaemonLauncher {
  return typeof value === 'function'
}

function readyChild(): unknown {
  return {
    pid: 12345,
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'message') {
        queueMicrotask(() => cb({ type: 'ready', pid: 12345, startedAtMs: 1_000_000 }))
      }
      return this
    },
    off: vi.fn(),
    disconnect: vi.fn(),
    unref: vi.fn()
  }
}

describe('daemon-init: macOS stable-bundle launch fallback', () => {
  beforeEach(() => {
    stableLaunch.deadlinesMs = []
    stableLaunch.failAtDeadlineOffsetMs = null
    installDefaultNetConnectStub()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  let launcherCalledAtMs = 0

  async function launchOnce(): Promise<unknown> {
    const mod = await importFresh()
    if (stableLaunch.failure === 'real') {
      // The real launcher only runs from a packaged app.
      isPackagedMock.mockReturnValue(true)
      getAppPathMock.mockReturnValue('/Applications/Orca.app/Contents/Resources/app.asar')
    }
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider(undefined, { macosLoginSessionWatch: true })
    const launcher = spawnerInstances.at(-1)?.launcher
    if (!isDaemonLauncher(launcher)) {
      throw new Error('initDaemonPtyProvider did not construct a spawner')
    }
    forkMock.mockClear()
    forkMock.mockReturnValueOnce(readyChild())
    launcherCalledAtMs = Date.now()
    return launcher('/fake/socket', '/fake/token')
  }

  it('forks the daemon from the app when no stable-bundle job can claim the endpoint', async () => {
    stableLaunch.failure = 'unavailable'
    await expect(launchOnce()).resolves.toBeTruthy()
    expect(forkMock).toHaveBeenCalledOnce()
  })

  it('hands off to the fork early enough for its readiness wait and adapter to fit the gate', async () => {
    stableLaunch.failure = 'unavailable'
    stableLaunch.failAtDeadlineOffsetMs = 0
    await expect(launchOnce()).resolves.toBeTruthy()
    expect(forkMock).toHaveBeenCalledOnce()
    const handoffMs = (stableLaunch.deadlinesMs[0] ?? Infinity) - launcherCalledAtMs
    // Even a stable failure at the last allowed moment leaves the whole fork budget in the gate.
    expect(handoffMs + DAEMON_CHILD_STARTUP_TIMEOUT_MS + 5_000).toBeLessThanOrEqual(
      LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS
    )
    // ...without starving the stable launch of its own bootstrap and readiness time.
    expect(handoffMs).toBeGreaterThan(20_000)
  })

  it('reports a stable failure too late for any fork to finish inside the gate', async () => {
    stableLaunch.failure = 'unavailable'
    stableLaunch.failAtDeadlineOffsetMs = 1
    await expect(launchOnce()).rejects.toThrow('Could not prepare the runtime')
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('keeps retiring copies when the stable launch is turned off', async () => {
    stableLaunch.failure = 'disabled'
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await expect(launchOnce()).resolves.toBeTruthy()
    expect(forkMock).toHaveBeenCalledOnce()
    // Copies made while it was on are only ever deleted by this collection.
    expect(retireMock).toHaveBeenCalledOnce()
    expect(retireMock.mock.calls[0]?.[0]).toMatch(/daemon-host[\\/]macos$/)
  })

  describe('with the real stable launcher', () => {
    const originalGetSystemVersion = Object.getOwnPropertyDescriptor(process, 'getSystemVersion')

    function stubSystemVersion(version: string): void {
      Object.defineProperty(process, 'getSystemVersion', {
        configurable: true,
        value: () => version
      })
    }

    beforeEach(() => {
      stableLaunch.failure = 'real'
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      materializeMock.mockReset()
    })

    afterEach(() => {
      stableLaunch.failure = 'unavailable'
      if (originalGetSystemVersion) {
        Object.defineProperty(process, 'getSystemVersion', originalGetSystemVersion)
      } else {
        Reflect.deleteProperty(process, 'getSystemVersion')
      }
    })

    it('forks when the running app ships no terminal host helper', async () => {
      stubSystemVersion('15.4')
      materializeMock.mockRejectedValue(
        new Error('The running app has no macOS terminal host helper')
      )
      await expect(launchOnce()).resolves.toBeTruthy()
      expect(materializeMock).toHaveBeenCalledOnce()
      expect(forkMock).toHaveBeenCalledOnce()
    })

    it('forks without copying on macOS below the helper floor', async () => {
      stubSystemVersion('13.4.1')
      await expect(launchOnce()).resolves.toBeTruthy()
      expect(materializeMock).not.toHaveBeenCalled()
      expect(forkMock).toHaveBeenCalledOnce()
    })
  })

  it('never forks beside a stable-bundle job whose fate is unknown', async () => {
    stableLaunch.failure = 'fatal'
    await expect(launchOnce()).rejects.toThrow('Could not start the macOS terminal service')
    expect(forkMock).not.toHaveBeenCalled()
  })
})
