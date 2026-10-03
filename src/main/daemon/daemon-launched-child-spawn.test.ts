import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnDaemonChildProcess } from './daemon-launched-child-spawn'

const { spawn, fork } = vi.hoisted(() => ({ spawn: vi.fn(), fork: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawn }))
vi.mock('../../shared/child-process/fork-process', () => ({ forkProcess: fork }))
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
        args: expect.not.arrayContaining(['--fresh-daemon-scope'])
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
