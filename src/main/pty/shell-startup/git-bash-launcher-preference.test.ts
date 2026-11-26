import { describe, expect, it } from 'vitest'
import { resolveGitBashPath } from './git-bash'

const INSTALL_FILES = [
  'D:\\Git\\bin\\bash.exe',
  'D:\\Git\\usr\\bin\\bash.exe',
  'D:\\Git\\cmd\\git.exe',
  'D:\\Git\\git-bash.exe'
]

function existsStub(files: readonly string[]): (path: string) => boolean {
  const present = new Set(files.map((file) => file.toLowerCase()))
  return (path: string) => present.has(path.toLowerCase())
}

describe('resolveGitBashPath launcher preference', () => {
  it('prefers bin\\bash.exe when PATH lists usr\\bin first', () => {
    const resolved = resolveGitBashPath({
      platform: 'win32',
      env: { Path: 'D:\\Git\\usr\\bin;D:\\Git\\cmd' },
      exists: existsStub(INSTALL_FILES)
    })
    expect(resolved).toBe('D:\\Git\\bin\\bash.exe')
  })

  it('falls back to usr\\bin\\bash.exe when no launcher exists', () => {
    const resolved = resolveGitBashPath({
      platform: 'win32',
      env: { Path: 'D:\\Git\\usr\\bin' },
      exists: existsStub(['D:\\Git\\usr\\bin\\bash.exe'])
    })
    expect(resolved).toBe('D:\\Git\\usr\\bin\\bash.exe')
  })

  it('returns null when no candidate exists', () => {
    expect(
      resolveGitBashPath({
        platform: 'win32',
        env: { Path: 'D:\\Git\\cmd' },
        exists: () => false
      })
    ).toBeNull()
  })
})
