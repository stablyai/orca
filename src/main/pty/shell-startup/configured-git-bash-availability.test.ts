import { describe, expect, it, vi } from 'vitest'
import { isConfiguredGitBashAvailable } from './git-bash'

describe('isConfiguredGitBashAvailable', () => {
  it('detects missing or present Git Bash on win32 only when configured', () => {
    expect(
      isConfiguredGitBashAvailable('git-bash', {
        platform: 'win32',
        env: {},
        exists: () => false
      })
    ).toBe(false)

    expect(
      isConfiguredGitBashAvailable('GIT-BASH', {
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        exists: (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    ).toBe(true)
  })

  it('returns undefined without probing disk for other shells or non-Windows hosts', () => {
    const exists = vi.fn(() => true)

    expect(isConfiguredGitBashAvailable('powershell.exe', { platform: 'win32', exists })).toBe(
      undefined
    )
    expect(isConfiguredGitBashAvailable(undefined, { platform: 'win32', exists })).toBe(undefined)
    expect(isConfiguredGitBashAvailable('git-bash', { platform: 'darwin', exists })).toBe(undefined)
    expect(exists).not.toHaveBeenCalled()
  })
})
