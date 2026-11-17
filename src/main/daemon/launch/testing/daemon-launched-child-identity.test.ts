import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from '../../endpoint/publication/daemon-endpoint-ownership'
import { launchDaemonChild } from '../daemon-launched-child'
import type { DaemonChildSpawnOptions } from '../daemon-launched-child-spawn'

const { spawnDaemonChildProcessMock, isDurableDaemonScopeSupportedMock } = vi.hoisted(() => ({
  spawnDaemonChildProcessMock: vi.fn(),
  isDurableDaemonScopeSupportedMock: vi.fn(() => false)
}))

vi.mock('../daemon-launched-child-spawn', () => ({
  spawnDaemonChildProcess: spawnDaemonChildProcessMock
}))
vi.mock('../../process-scopes/daemon-cgroup-scope', () => ({
  isDurableDaemonScopeSupported: isDurableDaemonScopeSupportedMock
}))
vi.mock('../daemon-spawner', () => ({ unlinkOwnedDaemonPidFile: vi.fn(() => true) }))

type FakeDaemonChild = EventEmitter & {
  pid: number
  disconnect: Mock
  unref: Mock
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

const LAUNCH_OPTIONS: DaemonChildSpawnOptions = {
  entryPath: '/fake/app/out/main/daemon-entry.js',
  forkEntryPath: '/fake/app/out/main/daemon-entry.js',
  userDataPath: '/fake/userData',
  socketPath: '/fake/socket',
  tokenPath: '/fake/token',
  pidPath: '/fake/daemon.pid',
  launchNonce: 'nonce-a',
  macosLoginSessionWatch: false
}

function fakeDaemonChild(pid: number): FakeDaemonChild {
  const child = new EventEmitter()
  return Object.assign(child, {
    pid,
    disconnect: vi.fn(),
    unref: vi.fn(),
    exitCode: null,
    signalCode: null
  })
}

afterEach(() => {
  vi.clearAllMocks()
  spawnDaemonChildProcessMock.mockReset()
  isDurableDaemonScopeSupportedMock.mockReturnValue(false)
})

describe('launchDaemonChild identity', () => {
  it('takes the PID the daemon reports for itself, not the immediate child PID', async () => {
    // Readiness identity must not depend on systemd-run having execed the daemon yet.
    isDurableDaemonScopeSupportedMock.mockReturnValue(true)
    const child = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockReturnValue(child)

    const launch = launchDaemonChild(LAUNCH_OPTIONS)
    child.emit('message', {
      type: 'ready',
      pid: 9999,
      startedAtMs: 1_700_000_000_000,
      linuxStartTicks: '5150',
      bootId: 'boot-a'
    })
    const launched = await launch

    expect(spawnDaemonChildProcessMock).toHaveBeenCalledWith(LAUNCH_OPTIONS, true)
    expect(launched.identity).toEqual({
      pid: 9999,
      startedAtMs: 1_700_000_000_000,
      linuxStartTicks: '5150',
      bootId: 'boot-a',
      launchNonce: 'nonce-a'
    })
  })

  it('rejects a readiness message that carries no self-reported PID', async () => {
    const child = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockReturnValue(child)
    // The startup-failure path signals the child; keep that off any real PID.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('already exited'), { code: 'ESRCH' })
    })

    try {
      const launch = launchDaemonChild(LAUNCH_OPTIONS)
      child.emit('message', { type: 'ready', startedAtMs: 1_700_000_000_000 })

      await expect(launch).rejects.toThrow('Daemon readiness identity is incomplete')
      expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
      expect(child.disconnect).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})

describe('launchDaemonChild durable-scope fallback', () => {
  it('does not retry when another daemon already owns the endpoint', async () => {
    isDurableDaemonScopeSupportedMock.mockReturnValue(true)
    const scoped = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockImplementation(() => {
      queueMicrotask(() => {
        scoped.exitCode = DAEMON_EXIT_ENDPOINT_OCCUPIED
        scoped.emit('exit', DAEMON_EXIT_ENDPOINT_OCCUPIED)
      })
      return scoped
    })

    await expect(launchDaemonChild(LAUNCH_OPTIONS)).rejects.toThrow(
      'Daemon could not take the endpoint: occupied'
    )
    expect(spawnDaemonChildProcessMock).toHaveBeenCalledOnce()
  })
})

describe('launchDaemonChild AppImage fallback', () => {
  const APPIMAGE_LAUNCH = {
    appImagePath: '/apps/Orca.AppImage',
    entryPathInAppDir: 'resources/app.asar.unpacked/out/main/daemon-entry.js',
    appPathInAppDir: 'resources/app.asar',
    appVersion: '1.0.0'
  }

  it('does not retry beside an AppImage attempt whose cleanup failed', async () => {
    isDurableDaemonScopeSupportedMock.mockReturnValue(true)
    const alive = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockImplementation(() => {
      queueMicrotask(() => alive.emit('message', { type: 'ready', startedAtMs: 1 }))
      return alive
    })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    try {
      const launch = launchDaemonChild({ ...LAUNCH_OPTIONS, appImage: APPIMAGE_LAUNCH })

      await expect(launch).rejects.toBeInstanceOf(AggregateError)
      expect(spawnDaemonChildProcessMock).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })
})

describe('launchDaemonChild on the extracted AppImage copy', () => {
  const APPIMAGE_LAUNCH = {
    appImagePath: '/apps/Orca.AppImage',
    entryPathInAppDir: 'resources/app.asar.unpacked/out/main/daemon-entry.js',
    appPathInAppDir: 'resources/app.asar',
    appVersion: '1.0.0'
  }
  const GENERATION_LAUNCH = {
    generationRoot: '/cache/ns/gen',
    nodePath: '/cache/ns/gen/resources/node-runtime/bin/node',
    entryPath: '/cache/ns/gen/resources/app.asar.unpacked/out/main/daemon-entry.js',
    identityPath: '/apps/Orca.AppImage/resources/app.asar.unpacked/out/main/daemon-entry.js'
  }

  it('never starts a second daemon beside a copy that lost the endpoint race', async () => {
    const child = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.exitCode = DAEMON_EXIT_ENDPOINT_OCCUPIED
        child.emit('exit', DAEMON_EXIT_ENDPOINT_OCCUPIED)
      })
      return child
    })
    await expect(
      launchDaemonChild({
        ...LAUNCH_OPTIONS,
        appImage: APPIMAGE_LAUNCH,
        extractedGeneration: GENERATION_LAUNCH
      })
    ).rejects.toMatchObject({ reason: 'occupied' })
    expect(spawnDaemonChildProcessMock).toHaveBeenCalledOnce()
  })
})
