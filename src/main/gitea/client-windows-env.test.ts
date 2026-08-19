import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getRegistryKeyMock } = vi.hoisted(() => ({
  getRegistryKeyMock: vi.fn()
}))

vi.mock('../windows-native-registry', () => ({
  WINDOWS_REG_SZ: 1,
  WINDOWS_REG_EXPAND_SZ: 2,
  loadWindowsNativeRegistry: () => ({
    HK: { LM: 1, CU: 2 },
    getRegistryKey: getRegistryKeyMock
  })
}))

import { getGiteaAuthStatus } from './client'

const OLD_ENV = process.env
const USER_ENVIRONMENT_KEY = 'Environment'
const MACHINE_ENVIRONMENT_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

function registryStrings(values: Record<string, string>): Record<string, { type: number; value: string }> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, { type: 1, value }])
  )
}

describe('getGiteaAuthStatus Windows environment snapshot (#14740)', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    getRegistryKeyMock.mockReset()
    getRegistryKeyMock.mockReturnValue({})
    vi.unstubAllGlobals()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('authenticates with user-registry credentials when process.env still has Explorer-frozen values', async () => {
    process.env.ORCA_GITEA_TOKEN = 'stale-explorer-token'
    process.env.ORCA_GITEA_API_BASE_URL = 'https://stale.example.com'
    getRegistryKeyMock.mockImplementation((root: number, key: string) => {
      if (root === 2 && key === USER_ENVIRONMENT_KEY) {
        return registryStrings({
          ORCA_GITEA_TOKEN: 'current-gitea-token',
          ORCA_GITEA_API_BASE_URL: 'https://gitea.example.com'
        })
      }
      return {}
    })

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization
      if (
        String(url) === 'https://gitea.example.com/api/v1/user' &&
        authorization === 'token current-gitea-token'
      ) {
        return Response.json({ login: 'gitea-user' })
      }
      return Response.json({ message: 'unauthorized' }, { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'gitea-user',
      baseUrl: 'https://gitea.example.com/api/v1',
      tokenConfigured: true
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://gitea.example.com/api/v1/user')
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'token current-gitea-token'
    )
  })

  it('does not consult the Windows registry outside win32', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    process.env.ORCA_GITEA_TOKEN = 'process-token'
    process.env.ORCA_GITEA_API_BASE_URL = 'https://process.example.com'
    getRegistryKeyMock.mockImplementation(() =>
      registryStrings({
        ORCA_GITEA_TOKEN: 'registry-token',
        ORCA_GITEA_API_BASE_URL: 'https://registry.example.com'
      })
    )
    const fetchMock = vi.fn(async () => Response.json({ login: 'process-user' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaAuthStatus()).resolves.toMatchObject({
      authenticated: true,
      baseUrl: 'https://process.example.com/api/v1'
    })
    expect(getRegistryKeyMock).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://process.example.com/api/v1/user')
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'token process-token'
    )
  })

  it('falls back to process.env when the native registry module cannot load', async () => {
    getRegistryKeyMock.mockImplementation(() => {
      throw new Error('native module unavailable')
    })
    process.env.ORCA_GITEA_TOKEN = 'stale-explorer-token'
    process.env.ORCA_GITEA_API_BASE_URL = 'https://stale.example.com'
    const fetchMock = vi.fn(async () => Response.json({ login: 'fallback-user' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaAuthStatus()).resolves.toMatchObject({
      authenticated: true,
      baseUrl: 'https://stale.example.com/api/v1'
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://stale.example.com/api/v1/user')
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'token stale-explorer-token'
    )
  })

  it('prefers the user Environment value over the machine Environment value', async () => {
    process.env.ORCA_GITEA_TOKEN = 'stale-explorer-token'
    process.env.ORCA_GITEA_API_BASE_URL = 'https://stale.example.com'
    getRegistryKeyMock.mockImplementation((root: number, key: string) => {
      if (root === 2 && key === USER_ENVIRONMENT_KEY) {
        return registryStrings({
          ORCA_GITEA_TOKEN: 'user-gitea-token',
          ORCA_GITEA_API_BASE_URL: 'https://user.example.com'
        })
      }
      if (root === 1 && key === MACHINE_ENVIRONMENT_KEY) {
        return registryStrings({
          ORCA_GITEA_TOKEN: 'machine-gitea-token',
          ORCA_GITEA_API_BASE_URL: 'https://machine.example.com'
        })
      }
      return {}
    })
    const fetchMock = vi.fn(async () => Response.json({ login: 'user-account' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaAuthStatus()).resolves.toMatchObject({
      account: 'user-account',
      baseUrl: 'https://user.example.com/api/v1'
    })
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'token user-gitea-token'
    )
  })
})
