import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'

describe('daemon PTY environment', () => {
  afterEach(() => vi.unstubAllEnvs())

  // #21119: the daemon's own env used to hand the marker to every shell and agent.
  it.each([
    ['inherited from the daemon', {}, true],
    ['sent by the client', { DBUS_SESSION_BUS_ADDRESS: 'disabled:' }, false]
  ])('strips the marker %s', (_label, explicitEnv, inherited) => {
    if (inherited) {
      vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'disabled:')
    }
    const env = createDaemonPtyEnvironment({ sessionId: 's', cols: 80, rows: 24, env: explicitEnv })
    expect(env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS')
  })

  it('keeps a real inherited address', () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus')
    const env = createDaemonPtyEnvironment({ sessionId: 's', cols: 80, rows: 24 })
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
  })
})
