import { describe, expect, it, vi } from 'vitest'
import {
  getGitBashCandidatePaths,
  isWindowsGitBashShellPath,
  resolveGitBashPath,
  resolveWindowsGitBashShellPath
} from './git-bash'

describe('Git Bash path discovery', () => {
  it('includes common Git for Windows install locations and PATH-derived fallbacks', () => {
    const candidates = getGitBashCandidatePaths({
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      Path: '"C:\\Program Files\\Git\\cmd";C:\\tools'
    })

    expect(candidates).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(candidates).toContain('C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
    expect(candidates).toContain('C:\\Program Files\\Git\\usr\\bin\\bash.exe')
    expect(candidates).toContain('C:\\tools\\bash.exe')
  })

  it('resolves the first existing common bash.exe path on Windows', () => {
    const exists = vi.fn((path: string) => path === 'C:\\Program Files\\Git\\bin\\bash.exe')

    expect(
      resolveGitBashPath({
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        exists
      })
    ).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('does not expose Git Bash discovery on non-Windows hosts', () => {
    expect(
      resolveGitBashPath({
        platform: 'darwin',
        env: { ProgramFiles: 'C:\\Program Files' },
        exists: () => true
      })
    ).toBeNull()
  })

  it('maps the persisted Git Bash sentinel to a discovered bash.exe path', () => {
    expect(
      resolveWindowsGitBashShellPath('git-bash', {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
        exists: (path) => path === 'C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
      })
    ).toBe('C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
  })

  it('honors an explicit bash.exe path for future user-configurable launch paths', () => {
    expect(resolveWindowsGitBashShellPath('D:\\PortableGit\\bin\\bash.exe')).toBe(
      'D:\\PortableGit\\bin\\bash.exe'
    )
  })

  it('recognizes Git Bash executable paths case-insensitively', () => {
    expect(isWindowsGitBashShellPath('D:\\PortableGit\\BIN\\BASH.EXE')).toBe(true)
  })
})
