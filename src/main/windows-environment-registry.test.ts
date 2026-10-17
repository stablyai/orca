import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __setWindowsEnvironmentRegistryLoaderForTests,
  readWindowsRegistryEnvironmentValue
} from './windows-environment-registry'

const USER_ENVIRONMENT_KEY = 'Environment'
const MACHINE_ENVIRONMENT_KEY = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

describe('readWindowsRegistryEnvironmentValue', () => {
  afterEach(() => {
    __setWindowsEnvironmentRegistryLoaderForTests()
    vi.restoreAllMocks()
  })

  it('prefers the user Environment value over the machine value', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const getRegistryKey = vi.fn((root: number, key: string) => {
      if (root === 2 && key === USER_ENVIRONMENT_KEY) {
        return { ORCA_GITEA_TOKEN: { type: 1, value: 'user-token' } }
      }
      if (root === 1 && key === MACHINE_ENVIRONMENT_KEY) {
        return { ORCA_GITEA_TOKEN: { type: 1, value: 'machine-token' } }
      }
      return {}
    })
    __setWindowsEnvironmentRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey
    }))

    expect(readWindowsRegistryEnvironmentValue('ORCA_GITEA_TOKEN')).toBe('user-token')
    expect(getRegistryKey).toHaveBeenNthCalledWith(1, 2, USER_ENVIRONMENT_KEY)
  })

  it('uses the machine Environment value when the user key omits the name', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    __setWindowsEnvironmentRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey: vi.fn((root: number, key: string) => {
        if (root === 1 && key === MACHINE_ENVIRONMENT_KEY) {
          return { orca_gitea_api_base_url: { type: 1, value: 'https://machine.example.com' } }
        }
        return {}
      })
    }))

    expect(readWindowsRegistryEnvironmentValue('ORCA_GITEA_API_BASE_URL')).toBe(
      'https://machine.example.com'
    )
  })

  it('expands REG_EXPAND_SZ values from the process environment', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const previousHost = process.env.ORCA_GITEA_HOST
    process.env.ORCA_GITEA_HOST = 'gitea.example.com'
    __setWindowsEnvironmentRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey: vi.fn(() => ({
        ORCA_GITEA_API_BASE_URL: { type: 2, value: 'https://%ORCA_GITEA_HOST%' }
      }))
    }))

    try {
      expect(readWindowsRegistryEnvironmentValue('ORCA_GITEA_API_BASE_URL')).toBe(
        'https://gitea.example.com'
      )
    } finally {
      if (previousHost === undefined) {
        delete process.env.ORCA_GITEA_HOST
      } else {
        process.env.ORCA_GITEA_HOST = previousHost
      }
    }
  })

  it('returns null outside Windows without opening the registry', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const getRegistryKey = vi.fn()
    __setWindowsEnvironmentRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey
    }))

    expect(readWindowsRegistryEnvironmentValue('ORCA_GITEA_TOKEN')).toBeNull()
    expect(getRegistryKey).not.toHaveBeenCalled()
  })

  it('returns null when the optional native module cannot load', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    __setWindowsEnvironmentRegistryLoaderForTests(() => {
      throw new Error('native module unavailable')
    })

    expect(readWindowsRegistryEnvironmentValue('ORCA_GITEA_TOKEN')).toBeNull()
  })
})
