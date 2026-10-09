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
