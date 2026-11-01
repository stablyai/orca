import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'

const fakes = vi.hoisted(() => ({
  host: {
    prepareLaunch: async () => ({ runtime: 'host' }),
    publish: () => {},
    systemDefaultHome: () => '/host/.claude'
  },
  wsl: {
    prepareLaunch: async (distro: string) => ({ runtime: 'wsl', wslDistro: distro }),
    preparation: async (distro: string) => ({ runtime: 'wsl', wslDistro: distro }),
    publish: async (_distro: string): Promise<void> => {},
    runningDistros: async (): Promise<string[]> => []
  }
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
  installClaudeObservedConfigDirs: () => {},
  installClaudeProfileRouter: () => {},
  installClaudeWslProfileRouter: () => {}
}))

import { ClaudeRuntimeAuthService } from './runtime-auth-service'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function service(
  platformName: NodeJS.Platform,
  overrides: Partial<GlobalSettings> = {},
  isDistroRunning: (distro: string) => Promise<boolean> = async () => true
) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platformName })
  const settings = { ...getDefaultSettings('/home/user'), ...overrides }
  return new ClaudeRuntimeAuthService({ getSettings: () => settings }, isDistroRunning)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

describe('ClaudeRuntimeAuthService', () => {
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

  it('prepares the settings-selected account for a quota fetch, not the router snapshot', async () => {
    const accountUsagePreparation = vi.fn(() => ({
      configDir: '/data/orca/claude-accounts/a1',
      envPatch: { CLAUDE_CONFIG_DIR: '/data/orca/claude-accounts/a1' },
      provenance: 'profile:a1'
    }))
    const preparation = vi.fn(() => ({
      configDir: '/host/.claude',
      envPatch: {},
      provenance: 'system'
    }))
    Object.assign(fakes.host, { accountUsagePreparation, preparation })
    const auth = service('darwin', {
      claudeManagedAccounts: [
        {
          id: 'a1',
          email: 'a1@example.com',
          managedAuthRuntime: 'host',
          managedAuthPath: '/data/orca/claude-accounts/a1',
          wslDistro: null,
          authMethod: 'unknown',
          organizationUuid: null,
          organizationName: null,
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ],
      activeClaudeManagedAccountId: 'a1'
    })
    await expect(auth.prepareForRateLimitFetch()).resolves.toMatchObject({
      provenance: 'profile:a1'
    })
    expect(accountUsagePreparation).toHaveBeenCalledWith('a1')
    expect(preparation).not.toHaveBeenCalled()
  })

  it('keeps the router preparation when no account is selected', async () => {
    const accountUsagePreparation = vi.fn()
    const preparation = vi.fn(() => ({ configDir: '/host/.claude', provenance: 'system' }))
    Object.assign(fakes.host, { accountUsagePreparation, preparation })
    const auth = service('darwin')
    await expect(auth.prepareForRateLimitFetch()).resolves.toMatchObject({
      configDir: '/host/.claude'
    })
    expect(preparation).toHaveBeenCalledWith()
    expect(accountUsagePreparation).not.toHaveBeenCalled()
  })
})
