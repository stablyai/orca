import { describe, expect, it } from 'vitest'
import { PI_CWD_BUCKET_LAYOUT } from './session-cwd-bucket-layouts'

function piDirInScope(dirName: string, scopePath: string): boolean {
  return PI_CWD_BUCKET_LAYOUT.isDirInScope(
    dirName,
    new Set(PI_CWD_BUCKET_LAYOUT.encodeScopePrefixes(scopePath))
  )
}

describe('PI_CWD_BUCKET_LAYOUT', () => {
  it('matches the scope bucket and nested cwd buckets', () => {
    expect(piDirInScope('--home-ada-repo--', '/home/ada/repo')).toBe(true)
    expect(piDirInScope('--home-ada-repo-src--', '/home/ada/repo')).toBe(true)
    expect(piDirInScope('--home-ada-repo--', '/home/ada/repo/')).toBe(true)
    expect(piDirInScope('--home-ada-repo-src--', '/home/ada/repo/')).toBe(true)
  })

  it('does not match an unrelated bucket', () => {
    expect(piDirInScope('--home-ada-other--', '/home/ada/repo')).toBe(false)
    expect(piDirInScope('--home-ada-reposit--', '/home/ada/repo')).toBe(false)
  })

  it('treats a root scope as containing every bucket', () => {
    expect(piDirInScope('--home-ada-repo--', '/')).toBe(true)
    expect(piDirInScope('----', '/')).toBe(true)
    expect(piDirInScope('not-a-bucket', '/')).toBe(false)
  })

  it('encodes Windows drive paths the way Pi does', () => {
    expect(piDirInScope('--C--Users-ada-repo--', 'C:\\Users\\ada\\repo')).toBe(true)
  })
})
