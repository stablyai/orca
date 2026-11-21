import { afterEach, describe, expect, it, vi } from 'vitest'
import { secretServiceProcessEnvironment } from './session-bus-environment'

vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({})) }))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('secretServiceProcessEnvironment', () => {
  it('uses the runtime bus when Chromium disables the inherited session bus', async () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'disabled:')
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000')

    const env = await secretServiceProcessEnvironment()

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
  })

  it('keeps a real session bus address', async () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/custom-bus')

    const env = await secretServiceProcessEnvironment()

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/tmp/custom-bus')
  })
})
