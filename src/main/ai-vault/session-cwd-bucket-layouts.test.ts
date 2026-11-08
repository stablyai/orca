import { describe, expect, it } from 'vitest'
import { PI_CWD_BUCKET_LAYOUT, CODEBUDDY_CWD_BUCKET_LAYOUT } from './session-cwd-bucket-layouts'

function piDirInScope(dirName: string, scopePath: string): boolean {
  return PI_CWD_BUCKET_LAYOUT.isDirInScope(
    dirName,
    new Set(PI_CWD_BUCKET_LAYOUT.encodeScopePrefixes(scopePath))
  )
}

describe('PI_CWD_BUCKET_LAYOUT', () => {
  it('does not match an unrelated bucket', () => {
    expect(piDirInScope('--home-ada-other--', '/home/ada/repo')).toBe(false)
    expect(piDirInScope('--home-ada-reposit--', '/home/ada/repo')).toBe(false)
  })
})

describe('CODEBUDDY_CWD_BUCKET_LAYOUT', () => {
  it.each([
    ['C:\\Users\\ada\\repo', 'C-Users-ada-repo-src'],
    ['/home/ada/repo', 'home-ada-repo-src'],
    ['/', 'home-ada-repo'],
    [`/${'界'.repeat(100)}`, `${'界'.repeat(60)}-hash`]
  ])('keeps candidate buckets for %s', (scope, bucket) => {
    expect(
      CODEBUDDY_CWD_BUCKET_LAYOUT.isDirInScope(
        bucket,
        new Set(CODEBUDDY_CWD_BUCKET_LAYOUT.encodeScopePrefixes(scope))
      )
    ).toBe(true)
  })
})
