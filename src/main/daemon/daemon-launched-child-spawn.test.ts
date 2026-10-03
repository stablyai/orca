import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnDaemonChildProcess } from './daemon-launched-child-spawn'

const { spawn, fork, repairSessionBusEnv } = vi.hoisted(() => {
  /** Apply a fixed address so launch tests isolate env forwarding from socket lookup. */
  const repairSessionBusEnv = vi.fn((env: Record<string, string | undefined>) => {
    if (env.DBUS_SESSION_BUS_ADDRESS === 'disabled:') {
      env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus'
    }
  })
  return { spawn: vi.fn(), fork: vi.fn(), repairSessionBusEnv }
})
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawn }))
vi.mock('../../shared/child-process/fork-process', () => ({ forkProcess: fork }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.0.0' })
}))
vi.mock('./daemon-launch-paths', () => ({ daemonLogArgs: () => [] }))
vi.mock('../pty/dbus-session-bus-env', () => ({
  repairDisabledSessionBusEnv: repairSessionBusEnv
}))

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

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

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

describe('daemon launch session bus', () => {
  it.each([true, false])(
    'hands the repaired bus address to the daemon (scoped launch: %s)',
    (useDurableScope) => {
      vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'disabled:')

      spawnDaemonChildProcess(options, useDurableScope)

      const launch = useDurableScope ? spawn : fork
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
          })
        })
      )
    }
  )
})
