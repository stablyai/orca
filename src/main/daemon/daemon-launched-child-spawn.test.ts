import { afterEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_V8_FLAGS, spawnDaemonChildProcess } from './daemon-launched-child-spawn'

const { spawn, fork } = vi.hoisted(() => ({ spawn: vi.fn(), fork: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawn }))
vi.mock('@orca/process-host/fork-process', () => ({ forkProcess: fork }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.0.0' })
}))
vi.mock('./daemon-launch-paths', () => ({ daemonLogArgs: () => [] }))

const options = {
  entryPath: '/app/daemon-entry.js',
  forkEntryPath: '/app/daemon-entry.js',
  userDataPath: '/tmp/orca',
  socketPath: '/tmp/orca/daemon.sock',
  tokenPath: '/tmp/orca/token',
  pidPath: '/tmp/orca/pid',
  launchNonce: 'scope-owner',
  macosLoginSessionWatch: false
}

afterEach(() => vi.clearAllMocks())

describe('daemon launch scope ownership', () => {
  it('only arms lifetime cleanup through the private scope launcher', () => {
    spawnDaemonChildProcess(options, true)
    expect(fork).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'systemd-run',
        args: expect.arrayContaining([
          '--scope',
          '--unit=orca-daemon-scope-owner.scope',
          '--property=TimeoutStopSec=5s',
          '--fresh-daemon-scope'
        ])
      })
    )
  })

  it('does not arm cleanup on the direct launch fallback', () => {
    spawnDaemonChildProcess(options, false)
    expect(spawn).not.toHaveBeenCalled()
    expect(fork).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.not.arrayContaining(['--fresh-daemon-scope']),
        execArgv: expect.arrayContaining([...DAEMON_V8_FLAGS])
      })
    )
  })
})

describe('daemon launch through the AppImage file', () => {
  const appImage = {
    appImagePath: '/apps/Orca.AppImage',
    entryPathInAppDir: 'resources/app.asar.unpacked/out/main/daemon-entry.js',
    appPathInAppDir: 'resources/app.asar',
    appVersion: '1.0.0'
  }

  it('execs the AppImage inside the durable scope', () => {
    spawnDaemonChildProcess({ ...options, appImage }, true)
    expect(fork).not.toHaveBeenCalled()
    const { program, args } = spawn.mock.calls[0][0]
    expect(program).toBe('systemd-run')
    const exec = args.indexOf('/apps/Orca.AppImage')
    expect(args.slice(exec + 1, exec + 2)).toEqual(['-e'])
    expect(args.slice(-2)).toEqual(['--fresh-daemon-scope', '--no-sandbox'])
  })

  it('spawns the AppImage directly on the unscoped fallback', () => {
    spawnDaemonChildProcess({ ...options, appImage }, false)
    expect(fork).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/apps/Orca.AppImage',
        args: expect.not.arrayContaining(['--fresh-daemon-scope']),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
    )
  })

  it('records an entry identity that survives the next mount', () => {
    spawnDaemonChildProcess({ ...options, appImage }, false)
    const { args } = spawn.mock.calls[0][0]
    expect(args[args.indexOf('--entry-path') + 1]).toBe(
      '/apps/Orca.AppImage/resources/app.asar.unpacked/out/main/daemon-entry.js'
    )
  })

  it('keeps the mount entry identity for the in-mount fallback', () => {
    spawnDaemonChildProcess(options, true)
    const { args } = spawn.mock.calls[0][0]
    expect(args[args.indexOf('--entry-path') + 1]).toBe('/app/daemon-entry.js')
  })
})

describe('daemon launch on the extracted AppImage copy', () => {
  const extractedGeneration = {
    generationRoot: '/cache/ns/gen',
    nodePath: '/cache/ns/gen/resources/node-runtime/bin/node',
    entryPath: '/cache/ns/gen/resources/app.asar.unpacked/out/main/daemon-entry.js',
    identityPath: '/apps/Orca.AppImage/resources/app.asar.unpacked/out/main/daemon-entry.js'
  }

  it.each([false, true])('runs the bundled Node on the copy (scoped=%s)', (scoped) => {
    spawnDaemonChildProcess({ ...options, extractedGeneration }, scoped)
    expect(fork).not.toHaveBeenCalled()
    const { program, args, env, stdio } = spawn.mock.calls[0][0]
    expect(program).toBe(scoped ? 'systemd-run' : extractedGeneration.nodePath)
    const node = args.indexOf(extractedGeneration.nodePath)
    // V8 flags must precede the entry, or Node hands them to the daemon script instead.
    expect(args.slice(node + 1, node + 2 + DAEMON_V8_FLAGS.length)).toEqual([
      ...DAEMON_V8_FLAGS,
      extractedGeneration.entryPath
    ])
    expect(args[args.indexOf('--entry-path') + 1]).toBe(extractedGeneration.identityPath)
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(stdio).toEqual(['ignore', 'ignore', 'pipe', 'ipc'])
  })
})

describe('daemon launch environment', () => {
  const originalBus = process.env.DBUS_SESSION_BUS_ADDRESS
  afterEach(() => {
    if (originalBus === undefined) {
      delete process.env.DBUS_SESSION_BUS_ADDRESS
    } else {
      process.env.DBUS_SESSION_BUS_ADDRESS = originalBus
    }
  })

  it.each([false, true])(
    "never hands Chromium's disabled: bus marker to the daemon (scoped=%s)",
    (scoped) => {
      process.env.DBUS_SESSION_BUS_ADDRESS = 'disabled:'
      spawnDaemonChildProcess(options, scoped)
      const spec = (scoped ? spawn : fork).mock.calls[0]?.[0]
      expect(spec.env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS')
      expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    }
  )

  it('keeps a real session bus address', () => {
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus'
    spawnDaemonChildProcess(options, false)
    expect(fork.mock.calls[0]?.[0].env.DBUS_SESSION_BUS_ADDRESS).toBe(
      'unix:path=/run/user/1000/bus'
    )
  })
})
