import { describe, expect, it, vi } from 'vitest'
import { checkServeUserDataPath } from './serve-user-data-path-guard'

describe('checkServeUserDataPath', () => {
  it('allows the chosen profile, including another spelling of it', () => {
    expect(
      checkServeUserDataPath({
        isServeMode: true,
        userDataPath: '/isolated/profile',
        env: { ORCA_SERVE_USER_DATA_PATH: '/isolated/./profile/' }
      })
    ).toBeNull()
    expect(
      checkServeUserDataPath({
        isServeMode: true,
        userDataPath: 'C:\\Users\\Me\\Orca',
        env: { ORCA_SERVE_USER_DATA_PATH: 'c:\\users\\me\\orca' },
        platform: 'win32'
      })
    ).toBeNull()
  })
})

describe('configureOrcaUserDataPathEnv on a serve launch', () => {
  it('throws before the instance lock instead of publishing a mismatched profile', async () => {
    vi.doMock('electron', () => ({ app: { getPath: () => '/default/orca' } }))
    const { configureOrcaUserDataPathEnv } = await import('../configure-process')
    const argv = process.argv
    const previous = process.env.ORCA_USER_DATA_PATH
    process.argv = [...argv, '--serve']
    process.env.ORCA_SERVE_USER_DATA_PATH = '/isolated/profile'
    process.env.ORCA_USER_DATA_PATH = '/isolated/profile'
    try {
      expect(() => configureOrcaUserDataPathEnv()).toThrow('/isolated/profile')
      expect(process.env.ORCA_USER_DATA_PATH).toBe('/isolated/profile')
    } finally {
      process.argv = argv
      delete process.env.ORCA_SERVE_USER_DATA_PATH
      if (previous === undefined) {
        delete process.env.ORCA_USER_DATA_PATH
      } else {
        process.env.ORCA_USER_DATA_PATH = previous
      }
      vi.doUnmock('electron')
    }
  })
})
