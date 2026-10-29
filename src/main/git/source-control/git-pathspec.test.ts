import { afterEach, describe, expect, it, vi } from 'vitest'
import { literalPathspec } from './git-pathspec'

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
