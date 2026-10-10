import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'

const fakes = vi.hoisted(() => ({
  host: {
    prepareLaunch: async () => ({ runtime: 'host' }),
    publish: () => {},
    systemDefaultHome: () => '/host/.claude',
    preparation: () => ({ configDir: '/host/.claude-custom', provenance: 'system' })
  },
  wsl: {
    prepareLaunch: async (distro: string) => ({ runtime: 'wsl', wslDistro: distro }),
    publish: async (_distro: string): Promise<void> => {},
    runningDistros: async (): Promise<string[]> => [],
    preparation: async (_distro: string) => ({
      configDir: String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude`,
      provenance: 'wsl:Ubuntu:system'
    })
  }
}))
vi.mock('../wsl/wsl-guest-environment', () => ({
  getWslGuestEnvironment: async () => ({ claudeConfigDir: '/home/ada/.claude-custom' })
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/data/orca' })
}))
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: (distro: string) => `/wsl/${distro}/home`
}))
vi.mock('./claude-profile-router', () => ({
  ClaudeProfileRouter: function ClaudeProfileRouter() {
    return fakes.host
  }
}))
vi.mock('./claude-profile-wsl-router', () => ({
  ClaudeWslProfileRouter: function ClaudeWslProfileRouter() {
    return fakes.wsl
  }
}))
vi.mock('./claude-profile-installed-router', () => ({
  installClaudeProfileRouter: () => {},
  installClaudeWslProfileRouter: () => {}
}))

import { ClaudeRuntimeAuthService } from './runtime-auth-service'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function service(platformName: NodeJS.Platform, overrides: Partial<GlobalSettings> = {}) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platformName })
  const settings = { ...getDefaultSettings('/home/user'), ...overrides }
  return new ClaudeRuntimeAuthService({ getSettings: () => settings })
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

describe('ClaudeRuntimeAuthService', () => {
  it('uses the routed host profile without probing WSL', async () => {
    const auth = service('darwin', { localAccountRuntime: 'wsl' })
    await expect(auth.getUsageProfileDirs()).resolves.toEqual([
      '/host/.claude-custom/projects',
      '/host/.claude-custom/transcripts'
    ])
  })

  it('reads the system-default WSL login environment config directory', async () => {
    const auth = service('win32', { localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' })
    await expect(auth.getUsageProfileDirs()).resolves.toEqual([
      String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-custom\projects`,
      String.raw`\\wsl.localhost\Ubuntu\home\ada\.claude-custom\transcripts`
    ])
  })

  it('keeps the selected managed WSL profile isolated from the system default', async () => {
    const profile = String.raw`\\wsl.localhost\Ubuntu\home\ada\.local\share\orca\claude-profiles\account\home`
    vi.spyOn(fakes.wsl, 'preparation').mockResolvedValue({
      configDir: profile,
      provenance: 'profile:account:wsl:Ubuntu'
    })
    const auth = service('win32', { localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' })
    await expect(auth.getUsageProfileDirs()).resolves.toEqual([
      `${profile}\\projects`,
      `${profile}\\transcripts`
    ])
  })

  it('reports an unavailable selected WSL runtime rather than scanning host history', async () => {
    vi.spyOn(fakes.wsl, 'preparation').mockRejectedValue(new Error('WSL unavailable'))
    const auth = service('win32', { localAccountRuntime: 'wsl' })
    await expect(auth.getUsageProfileDirs()).rejects.toThrow('WSL unavailable')
  })
  it('keeps a stale WSL account setting on the host off Windows', async () => {
    const auth = service('darwin', { localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' })
    expect(auth.getRuntimeConfigDir()).toBe('/host/.claude')
    await expect(auth.prepareForClaudeLaunch()).resolves.toEqual({ runtime: 'host' })
  })

  it('routes a WSL target that names no distro to the default distro', async () => {
    const auth = service('win32')
    await expect(auth.prepareForClaudeLaunch({ runtime: 'wsl', wslDistro: null })).resolves.toEqual(
      { runtime: 'wsl', wslDistro: 'Ubuntu' }
    )
    expect(auth.getRuntimeConfigDir({ runtime: 'wsl', wslDistro: null })).toBe(
      '/wsl/Ubuntu/home/.claude'
    )
  })

  it('never fails a select over a failed guest publish, and publishes one pass at a time', async () => {
    const auth = service('win32')
    vi.spyOn(fakes.wsl, 'publish').mockRejectedValue(new Error('distro is gone'))
    await expect(
      auth.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toBeUndefined()

    const order: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(fakes.host, 'publish').mockImplementation(() => order.push('host'))
    vi.spyOn(fakes.wsl, 'runningDistros')
      .mockImplementationOnce(async () => {
        await gate
        order.push('first guests')
        return []
      })
      .mockResolvedValue([])
    const first = auth.publishAll()
    const second = auth.publishAll()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(['host'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['host', 'first guests', 'host'])
  })
})
