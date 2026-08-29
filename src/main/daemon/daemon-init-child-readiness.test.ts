import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './types'
import { FAKE_DAEMON_ENTRY_PATH, FAKE_USER_DATA_PATH } from './daemon-init-test-harness'

const {
  writeFileSyncMock,
  forkMock,
  checkDaemonHealthMock,
  getProcessStartedAtMsMock,
  launchedStartedAtMs,
  spawnerInstances,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

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

describe('daemon-init: runRestartDaemon (7-step sequence)', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('removes detached daemon startup listeners after readiness', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const offMock = vi.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
      return child
    })
    const child = {
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'message') {
          queueMicrotask(() =>
            cb({
              type: 'ready',
              startedAtMs: 1_000_000,
              linuxStartTicks: '4242',
              bootId: 'boot-a'
            })
          )
        }
        return this
      },
      off: offMock,
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await launcher('/fake/socket', '/fake/token')

    const launchedArgsWithoutWatch = forkMock.mock.calls.at(-1)?.[1] as string[]
    expect(launchedArgsWithoutWatch).not.toContain('--login-session-watch')

    expect(offMock).toHaveBeenCalledWith('message', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('error', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('exit', expect.any(Function))
    expect(handlers.message).toHaveLength(0)
    expect(handlers.error).toHaveLength(0)
    expect(handlers.exit).toHaveLength(1)
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
    expect(writeFileSyncMock).not.toHaveBeenCalled()
    const launchArgs = forkMock.mock.calls.at(-1)?.[1] as string[]
    const launchNonceIndex = launchArgs.indexOf('--launch-nonce')
    expect(launchArgs).toEqual(
      expect.arrayContaining([
        '--pid-record',
        `/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`,
        '--launch-nonce',
        expect.stringMatching(/^[0-9a-f-]{36}$/),
        '--entry-path',
        FAKE_DAEMON_ENTRY_PATH,
        '--app-version',
        '1.2.3',
        '--spawner-exec-path',
        process.execPath
      ])
    )
    expect(launchArgs[launchNonceIndex + 1]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('leaves exclusive PID publication to the daemon child', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const child = {
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      off: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await launcher('/fake/socket', '/fake/token')

    expect(writeFileSyncMock).not.toHaveBeenCalled()
    expect(forkMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining([
        '--pid-record',
        `/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`,
        '--entry-path',
        FAKE_DAEMON_ENTRY_PATH,
        '--app-version',
        '1.2.3',
        '--spawner-exec-path',
        process.execPath
      ])
    )
  })

  it('keeps daemon stderr observable after readiness without retaining Electron', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: [],
      close: []
    }
    const stderrOff = vi.fn()
    const stderrDestroy = vi.fn()
    const stderrUnref = vi.fn()
    const stderrDataHandlers: ((chunk: Buffer) => void)[] = []
    const stderrEndHandlers: (() => void)[] = []
    const stderr = {
      on(event: string, callback: (chunk: Buffer) => void) {
        if (event === 'data') {
          stderrDataHandlers.push(callback)
        } else if (event === 'end' || event === 'close') {
          stderrEndHandlers.push(callback as () => void)
        }
        return this
      },
      off: stderrOff,
      destroy: stderrDestroy,
      unref: stderrUnref
    }
    const child = {
      pid: 12345,
      stderr,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      once(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        return this
      },
      off: vi.fn(() => child),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await launcher('/fake/socket', '/fake/token')

    expect(stderrOff).not.toHaveBeenCalledWith('data', expect.any(Function))
    expect(stderrDestroy).not.toHaveBeenCalled()
    expect(stderrUnref).toHaveBeenCalledOnce()
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()

    for (const handler of stderrDataHandlers) {
      handler(Buffer.from('FATAL ERROR: heap limit reached'))
    }
    for (const handler of handlers.exit) {
      handler(134)
    }
    for (const handler of stderrEndHandlers) {
      handler()
    }

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log'),
      expect.stringContaining('"event":"process-exit-observed","verdict":"exited","exitCode":134'),
      { flag: 'a', mode: 0o600 }
    )
    expect(writeFileSyncMock.mock.calls.at(-1)?.[1]).toContain('"launchNonce":')
    expect(writeFileSyncMock.mock.calls.at(-1)?.[1]).toContain('FATAL ERROR: heap limit reached')
  })

  it('accepts the daemon self-reported start time when the OS query returns null', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    getProcessStartedAtMsMock.mockReturnValue(null)
    launchedStartedAtMs.current = 1_700_000_123_456
    forkMock.mockImplementationOnce(() => ({
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_700_000_123_456 }))
        }
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))

    await launcher('/fake/socket', '/fake/token')

    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })
})
