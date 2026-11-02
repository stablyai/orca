import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitReportedPath, literalPathspec } from './git-pathspec'

describe('literalPathspec', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posix-normalizes a Windows-style path when only the cwd says WSL', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(
      literalPathspec('src\\index.ts', '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo', {})
    ).toBe(':(literal)src/index.ts')
  })

  it('leaves a host path untouched', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(literalPathspec('src\\index.ts', 'C:\\repo', {})).toBe(':(literal)src\\index.ts')
  })
})

describe('gitReportedPath', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('matches Git status output for a native Windows path', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(gitReportedPath('src\\app.ts', 'C:\\repo', {})).toBe('src/app.ts')
  })

  it('keeps a POSIX filename backslash, which Git prints literally', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    expect(gitReportedPath('dir\\file.txt', '/repo', {})).toBe('dir\\file.txt')
  })
})
