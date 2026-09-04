import { describe, expect, it } from 'vitest'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'

describe('normalizeRuntimeRelativePath', () => {
  it('preserves valid relative paths and normalizes backslashes', () => {
    expect(normalizeRuntimeRelativePath('src/main/index.ts')).toBe('src/main/index.ts')
    expect(normalizeRuntimeRelativePath('src\\main\\index.ts')).toBe('src/main/index.ts')
    expect(normalizeRuntimeRelativePath('nested/dir/file.txt')).toBe('nested/dir/file.txt')
  })

  it('strips leading ./ and repeated ./ prefixes from shell tab completion', () => {
    expect(normalizeRuntimeRelativePath('./src/main/index.ts')).toBe('src/main/index.ts')
    expect(normalizeRuntimeRelativePath('.\\src\\main\\index.ts')).toBe('src/main/index.ts')
    expect(normalizeRuntimeRelativePath('././src/main/index.ts')).toBe('src/main/index.ts')
    expect(normalizeRuntimeRelativePath('.\\.\\src\\main\\index.ts')).toBe('src/main/index.ts')
  })

  it('strips trailing slashes', () => {
    expect(normalizeRuntimeRelativePath('src/main/')).toBe('src/main')
    expect(normalizeRuntimeRelativePath('./src/main///')).toBe('src/main')
  })

  it('returns empty string for bare dot or empty input', () => {
    expect(normalizeRuntimeRelativePath('')).toBe('')
    expect(normalizeRuntimeRelativePath('.')).toBe('')
    expect(normalizeRuntimeRelativePath('./')).toBe('')
    expect(normalizeRuntimeRelativePath('././')).toBe('')
  })

  it('throws invalid_relative_path on absolute paths and path traversal', () => {
    expect(() => normalizeRuntimeRelativePath('/etc/passwd')).toThrow('invalid_relative_path')
    expect(() => normalizeRuntimeRelativePath('C:\\Windows\\System32')).toThrow('invalid_relative_path')
    expect(() => normalizeRuntimeRelativePath('../outside')).toThrow('invalid_relative_path')
    expect(() => normalizeRuntimeRelativePath('./../outside')).toThrow('invalid_relative_path')
    expect(() => normalizeRuntimeRelativePath('foo/../../bar')).toThrow('invalid_relative_path')
  })
})

describe('joinWorktreeRelativePath', () => {
  it('joins posix root with relative path', () => {
    expect(joinWorktreeRelativePath('/app/repo', 'src/index.ts')).toBe('/app/repo/src/index.ts')
    expect(joinWorktreeRelativePath('/app/repo', 'src\\index.ts')).toBe('/app/repo/src/index.ts')
  })

  it('joins windows root with relative path', () => {
    expect(joinWorktreeRelativePath('C:\\app\\repo', 'src/index.ts')).toBe('C:\\app\\repo\\src\\index.ts')
    expect(joinWorktreeRelativePath('C:/app/repo', 'src\\index.ts')).toBe('C:\\app\\repo\\src\\index.ts')
  })
})
