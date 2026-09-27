import { describe, expect, it, vi } from 'vitest'
import {
  getGitBashCandidatePaths,
  isGitForWindowsBashLauncherPath,
  isWindowsGitBashShellPath,
  resolveGitBashPath,
  resolveWindowsGitBashShellPath
} from './git-bash'

describe('Git Bash path discovery', () => {
  it('includes common Git for Windows install locations and PATH-derived fallbacks', () => {
    const candidates = getGitBashCandidatePaths({
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      Path: '"C:\\Program Files\\Git\\cmd";C:\\tools;C:\\PortableGit\\bin'
    })

    expect(candidates).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(candidates).toContain('C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
    expect(candidates).toContain('C:\\Program Files\\Git\\usr\\bin\\bash.exe')
    expect(candidates).toContain('C:\\PortableGit\\bin\\bash.exe')
    expect(candidates).not.toContain('C:\\tools\\bash.exe')
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

  // Why: resolveWindowsGitBashShellPath has no platform guard of its own, so passing options
  // explicitly keeps these assertions meaningful on non-Windows CI hosts.
  it('honors an explicit bash.exe path for future user-configurable launch paths', () => {
    expect(
      resolveWindowsGitBashShellPath('D:\\PortableGit\\bin\\bash.exe', {
        platform: 'win32',
        env: {},
        exists: (path) => path === 'D:\\PortableGit\\bin\\bash.exe'
      })
    ).toBe('D:\\PortableGit\\bin\\bash.exe')
  })

  it('rejects an explicit Git Bash path that is no longer installed', () => {
    expect(
      resolveWindowsGitBashShellPath('D:\\PortableGit\\bin\\bash.exe', {
        platform: 'win32',
        env: {},
        exists: () => false
      })
    ).toBeNull()
  })

  it('resolves a bare bash entry through Git Bash discovery', () => {
    expect(
      resolveWindowsGitBashShellPath('bash', {
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        exists: (path) => path === 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    ).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('returns null for a bare bash entry when Git Bash is not installed', () => {
    expect(
      resolveWindowsGitBashShellPath('bash', {
        platform: 'win32',
        env: { ProgramFiles: 'C:\\Program Files' },
        exists: () => false
      })
    ).toBeNull()
  })

  it('resolves an extension-less Git Bash path to the bash.exe it names', () => {
    expect(
      resolveWindowsGitBashShellPath('C:\\Program Files\\Git\\bin\\bash', {
        platform: 'win32',
        env: {},
        exists: (path) => path === 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    ).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('returns null for an extension-less Git Bash path with no bash.exe beside it', () => {
    expect(
      resolveWindowsGitBashShellPath('C:\\Program Files\\Git\\bin\\bash', {
        platform: 'win32',
        env: {},
        exists: () => false
      })
    ).toBeNull()
  })

  it('does not treat an extension-less non-Git bash path as Git Bash', () => {
    expect(
      resolveWindowsGitBashShellPath('C:\\cygwin64\\bin\\bash', {
        platform: 'win32',
        env: {},
        exists: () => true
      })
    ).toBeNull()
  })

  it('does not probe a bash-prefixed path that is not bash itself', () => {
    expect(
      resolveWindowsGitBashShellPath('C:\\Program Files\\Git\\bin\\bash.old', {
        platform: 'win32',
        env: {},
        exists: () => true
      })
    ).toBeNull()
  })

  it('recognizes Git Bash executable paths case-insensitively', () => {
    expect(isWindowsGitBashShellPath('D:\\PortableGit\\BIN\\BASH.EXE')).toBe(true)
  })

  it('does not classify arbitrary bash.exe paths as Git Bash', () => {
    expect(
      resolveWindowsGitBashShellPath('C:\\msys64\\usr\\bin\\bash.exe', {
        platform: 'win32',
        env: {},
        exists: () => true
      })
    ).toBeNull()
    expect(isWindowsGitBashShellPath('C:\\cygwin64\\bin\\bash.exe')).toBe(false)
  })

  it('ignores non-Git bash.exe candidates discovered through PATH', () => {
    expect(
      resolveGitBashPath({
        platform: 'win32',
        env: { Path: 'C:\\msys64\\usr\\bin' },
        exists: (path) => path === 'C:\\msys64\\usr\\bin\\bash.exe'
      })
    ).toBeNull()
  })

  it('identifies only the bin\\bash.exe launcher, not the MSYS bash it runs', () => {
    expect(isGitForWindowsBashLauncherPath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true)
    expect(isGitForWindowsBashLauncherPath('D:\\PortableGit\\bin\\bash.exe')).toBe(true)
    expect(isGitForWindowsBashLauncherPath('C:\\Program Files\\Git\\usr\\bin\\bash.exe')).toBe(
      false
    )
    expect(isGitForWindowsBashLauncherPath('bash.exe')).toBe(false)
  })

  it('identifies a launcher in an install folder named anything else', () => {
    // Layout confirmed against a real Git 2.x install: bin, cmd, mingw64, usr, git-bash.exe.
    const renamedInstall = (path: string): boolean =>
      [
        'C:\\Tools\\Git-2.55\\bin\\bash.exe',
        'C:\\Tools\\Git-2.55\\usr\\bin\\bash.exe',
        'C:\\Tools\\Git-2.55\\cmd\\git.exe',
        'C:\\Tools\\Git-2.55\\git-bash.exe'
      ].includes(path)
    expect(
      isGitForWindowsBashLauncherPath('C:\\Tools\\Git-2.55\\bin\\bash.exe', {
        exists: renamedInstall
      })
    ).toBe(true)
    expect(
      isGitForWindowsBashLauncherPath('C:\\Users\\a\\scoop\\apps\\git\\current\\bin\\bash.exe', {
        exists: (path) => path.startsWith('C:\\Users\\a\\scoop\\apps\\git\\current\\')
      })
    ).toBe(true)
  })

  // Each marker is individually necessary, so dropping one from the predicate cannot stay green.
  it.each([
    ['usr\\bin\\bash.exe', 'C:\\Tools\\Git-2.55\\usr\\bin\\bash.exe'],
    ['cmd\\git.exe', 'C:\\Tools\\Git-2.55\\cmd\\git.exe'],
    ['git-bash.exe', 'C:\\Tools\\Git-2.55\\git-bash.exe']
  ])('refuses a renamed install root missing only %s', (_label, missingMarker) => {
    expect(
      isGitForWindowsBashLauncherPath('C:\\Tools\\Git-2.55\\bin\\bash.exe', {
        exists: (path) => path !== missingMarker
      })
    ).toBe(false)
  })

  it('refuses a bash that is not a Git for Windows launcher, even where every path exists', () => {
    const everythingExists = (): boolean => true
    // A directly launched MSYS bash: no install root sits inside `usr`, so the markers cannot be met.
    expect(
      isGitForWindowsBashLauncherPath('C:\\Program Files\\Git\\usr\\bin\\bash.exe', {
        exists: (path) => !path.includes('\\usr\\usr\\') && !path.includes('\\usr\\cmd\\')
      })
    ).toBe(false)
    // Observed on a real Cygwin root: none of the three markers is present, nor bin\bash.exe itself.
    const observedCygwinRoot = ['C:\\cygwin64\\etc', 'C:\\cygwin64\\var']
    expect(
      isGitForWindowsBashLauncherPath('C:\\cygwin64\\bin\\bash.exe', {
        exists: (path) => observedCygwinRoot.includes(path)
      })
    ).toBe(false)
    // A Cygwin root carrying a bash at both marker positions is still refused: `git-bash.exe` is Git
    // for Windows' own launcher, and no Cygwin package installs one.
    expect(
      isGitForWindowsBashLauncherPath('C:\\cygwin64\\bin\\bash.exe', {
        exists: (path) => path.endsWith('bin\\bash.exe') || path.endsWith('cmd\\git.exe')
      })
    ).toBe(false)
    expect(
      isGitForWindowsBashLauncherPath('C:\\Tools\\sh\\bash.exe', { exists: everythingExists })
    ).toBe(false)
    expect(isGitForWindowsBashLauncherPath('bash.exe', { exists: everythingExists })).toBe(false)
  })
})
