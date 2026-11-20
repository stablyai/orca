import { afterEach, describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { secretServiceProcessEnvironment } from './session-bus-environment'

vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({})) }))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('secretServiceProcessEnvironment', () => {
  it.each(['disabled:', 'none:'])(
    'replaces the %s no-bus marker with the runtime bus',
    async (marker) => {
      // Electron's main process inherits Chromium's `disabled:` marker.
      vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', marker)
      vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000')

      const env = await secretServiceProcessEnvironment()

      expect(stat).toHaveBeenCalledWith('/run/user/1000/bus')
      expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
    }
  )

  it('keeps a real session bus address', async () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/custom-bus')

    const env = await secretServiceProcessEnvironment()

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/tmp/custom-bus')
  })
})
