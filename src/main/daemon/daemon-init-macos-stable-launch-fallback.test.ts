import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacDaemonLaunchd from './macos-daemon-launchd'
import type { DaemonLauncher } from './daemon-spawner'

const {
  stableLaunch,
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
    failure: 'unavailable' | 'fatal' | 'real'
    deadlinesMs: number[]
  } = { failure: 'unavailable', deadlinesMs: [] }
  return {
    stableLaunch,
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
vi.mock('../ipc/pty/provider/registry', () => moduleFactories.ptyProviderRegistry())
vi.mock('../ipc/pty/provider/listener-lifecycle', () => moduleFactories.ptyListenerLifecycle())
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
      if (stableLaunch.failure === 'unavailable') {
        return null
      }
      throw new Error('Could not start the macOS terminal service')
    }
  }
})

vi.mock('./macos-daemon-bundle', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeMacDaemonBundle: materializeMock
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
    installDefaultNetConnectStub()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

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
    return launcher('/fake/socket', '/fake/token')
  }

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
  })

  it('never forks beside a stable-bundle job whose fate is unknown', async () => {
    stableLaunch.failure = 'fatal'
    await expect(launchOnce()).rejects.toThrow('Could not start the macOS terminal service')
    expect(forkMock).not.toHaveBeenCalled()
  })
})
