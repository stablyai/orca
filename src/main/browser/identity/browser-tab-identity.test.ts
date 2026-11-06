import { afterEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted((): { release: string; contract: unknown } => ({
  release: '',
  contract: undefined
}))

vi.mock('electron', () => ({ app: { runningUnderARM64Translation: false } }))
vi.mock('node:os', () => ({ release: () => host.release }))
vi.mock('../../windows/windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => ({
    HK: { LM: 2 },
    getRegistryKey: () => ({ 'Windows.Foundation.UniversalApiContract': { value: host.contract } })
  })
}))

describe('desktopUserAgentMetadata on Windows', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it.each([
    ['10.0.22631', 0x130000, '19.0.0'],
    ['10.0.19045', 0x0a0001, '10.1.0'],
    ['10.0.26100', undefined, '19.0.0'],
    ['10.0.17134', 0x0a0000, '6.0.0'],
    ['10.0.10240', undefined, '1.0.0']
  ])(
    'reports platformVersion for build %s, contract %s as %s',
    async (build, contract, expected) => {
      host.release = build
      host.contract = contract
      vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'x64' })
      const { desktopUserAgentMetadata } = await import('./browser-tab-identity')
      expect(desktopUserAgentMetadata()).toEqual({
        platform: 'Windows',
        platformVersion: expected,
        architecture: 'x86',
        model: '',
        mobile: false
      })
    }
  )
})
