import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import {
  createLocalPtyLaunchPlan,
  DeferredLocalPtyLaunchPlan
} from '../providers/local-pty-launch-plan'
import { buildLocalPtySpawnEnvironment } from '../providers/local-pty-spawn-environment'

const { REPAIRED, repairSessionBusEnv } = vi.hoisted(() => {
  const repairedAddress = 'unix:path=/run/user/1000/bus'
  /** Apply a fixed address so wiring tests isolate call sites from socket lookup. */
  const repairSessionBusEnv = (env: Record<string, string | undefined>) => {
    if (env.DBUS_SESSION_BUS_ADDRESS === 'disabled:') {
      env.DBUS_SESSION_BUS_ADDRESS = repairedAddress
    }
  }
  return { REPAIRED: repairedAddress, repairSessionBusEnv }
})

// Why: the helper itself is covered against real sockets in dbus-session-bus-env.test.ts. Here a
// stand-in proves each spawn path calls it on the final env, so removing a call fails a test.
vi.mock('./dbus-session-bus-env', () => ({
  repairDisabledSessionBusEnv: repairSessionBusEnv
}))

vi.mock('../providers/local-pty-utils', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  validateWorkingDirectory: vi.fn()
}))

afterEach(() => vi.unstubAllEnvs())

describe('session-bus repair wiring', () => {
  it('repairs the marker inherited by daemon PTY shells', () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'disabled:')

    const env = createDaemonPtyEnvironment({ sessionId: 'session', cols: 80, rows: 24 })

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(REPAIRED)
  })

  it('repairs the marker passed explicitly to a daemon PTY', () => {
    const env = createDaemonPtyEnvironment({
      sessionId: 'session',
      cols: 80,
      rows: 24,
      env: { DBUS_SESSION_BUS_ADDRESS: 'disabled:' }
    })

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(REPAIRED)
  })

  it.skipIf(process.platform === 'win32')(
    'repairs the marker inherited by local PTY shells',
    () => {
      vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'disabled:')
      const spawn = { cwd: '/tmp', cols: 80, rows: 24 }
      const getOptions = () => ({})
      const plan = createLocalPtyLaunchPlan(spawn, () => ({ getDefaultShell: () => '/bin/sh' }))
      if (plan instanceof DeferredLocalPtyLaunchPlan) {
        throw new Error('a POSIX launch plan is never deferred')
      }

      const env = buildLocalPtySpawnEnvironment({ id: 'pty', spawn, getOptions, plan })

      expect(env).toMatchObject({ DBUS_SESSION_BUS_ADDRESS: REPAIRED })
    }
  )
})
