import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/orcad-profile-preflight'

/**
 * The precondition is only worth anything if it runs first. A loader failure is not
 * catchable, so a preflight that lands after `main()` has already reached
 * `await import('../ipc/pty')` prevents nothing.
 */
const { order, profileProbe } = vi.hoisted(() => {
  const order: string[] = []
  return { order, profileProbe: vi.fn(async () => {}) }
})

vi.mock('./orcad-bundled-runtime', () => ({ handoffToBundledOrcad: () => false }))
vi.mock('./orcad-profile-preflight', () => ({
  preflightBundledOrcadStartup: async () => {
    order.push('profile-admission')
  },
  runOrcadProfilePreflight: profileProbe
}))

beforeEach(() => {
  vi.resetModules()
  order.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

vi.mock('./orcad-native-preflight', () => ({
  runOrcadNativePreflight: () => {
    order.push('preflight')
    return true
  }
}))

vi.mock('./orcad-entry', () => ({
  main: async () => {
    order.push('main')
  }
}))

describe('orcad entry', () => {
  it.each([
    { flag: ORCAD_PROFILE_PREFLIGHT_FLAG, nativeFeatures: true },
    { flag: ORCAD_STARTUP_PREFLIGHT_FLAG, nativeFeatures: false }
  ])(
    'runs the selected disposable probe without starting a server: $flag',
    async ({ flag, nativeFeatures }) => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', flag, 'nonce'])
      await import('./main')
      expect(profileProbe).toHaveBeenCalledExactlyOnceWith('nonce', { nativeFeatures })
      expect(order).toEqual([])
    }
  )

  it('runs the native preflight before starting the runtime', async () => {
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('main'))

    expect(order).toEqual(['profile-admission', 'preflight', 'main'])
  })
})
