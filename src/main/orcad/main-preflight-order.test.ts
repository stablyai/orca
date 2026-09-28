import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_NATIVE_PREFLIGHT_CHILD_FLAG,
  ORCAD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/orcad-profile-preflight'

const { order, profileProbe, windowsProbe } = vi.hoisted(() => {
  const order: string[] = []
  return { order, profileProbe: vi.fn(async () => {}), windowsProbe: vi.fn(async () => {}) }
})

vi.mock('./orcad-profile-preflight', () => ({
  preflightBundledOrcadStartup: async () => {
    order.push('profile-admission')
  },
  runOrcadProfilePreflight: profileProbe,
  runBundledWindowsProfilePreflight: windowsProbe
}))

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, bun: 'test' })
  order.length = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

vi.mock('./orcad-entry', () => ({
  main: async () => {
    order.push('main')
  }
}))

describe('orcad entry', () => {
  it.each([
    { flag: ORCAD_PROFILE_PREFLIGHT_FLAG, nativeFeatures: true },
    { flag: ORCAD_NATIVE_PREFLIGHT_CHILD_FLAG, nativeFeatures: true },
    { flag: ORCAD_STARTUP_PREFLIGHT_FLAG, nativeFeatures: false }
  ])(
    'runs the selected disposable probe without starting a server: $flag',
    async ({ flag, nativeFeatures }) => {
      vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', flag, 'nonce'])
      await import('./orcad-app')
      expect(profileProbe).toHaveBeenCalledExactlyOnceWith('nonce', { nativeFeatures })
      expect(order).toEqual([])
    }
  )

  it.each([
    { flag: ORCAD_PROFILE_PREFLIGHT_FLAG, child: true },
    { flag: ORCAD_NATIVE_PREFLIGHT_CHILD_FLAG, child: false }
  ])('routes Windows native probe without recursion: $flag', async ({ flag, child }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['runtime', 'orcad.js', flag, 'nonce'])
    await import('./orcad-app')
    if (child) {
      expect(windowsProbe).toHaveBeenCalledExactlyOnceWith('nonce')
      expect(profileProbe).not.toHaveBeenCalled()
    } else {
      expect(profileProbe).toHaveBeenCalledExactlyOnceWith('nonce', { nativeFeatures: true })
      expect(windowsProbe).not.toHaveBeenCalled()
    }
    expect(order).toEqual([])
  })

  it('checks bundled runtime readiness before starting the server', async () => {
    await import('./orcad-app')
    await vi.waitFor(() => expect(order).toContain('main'))

    expect(order).toEqual(['profile-admission', 'main'])
  })
})
