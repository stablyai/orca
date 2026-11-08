import { describe, expect, it } from 'vitest'
import { createRootPathRewriter } from './watcher-event-root-path-rewrite'

describe('createRootPathRewriter', () => {
  it('does not treat backslash as a separator for POSIX roots', () => {
    const rewrite = createRootPathRewriter('/tmp/link', '/private/tmp/real', 'darwin')
    expect(rewrite('/private/tmp/real/we\\ird/a.ts')).toBe('/tmp/link/we\\ird/a.ts')
  })

  it('rewrites forward-slash UNC roots on Windows', () => {
    const rewrite = createRootPathRewriter('//srv/share/link', '\\\\srv\\share\\real', 'win32')
    expect(rewrite('\\\\srv\\share\\real\\src\\a.ts')).toBe('//srv/share/link/src\\a.ts')
  })

  // Separator-aware matching prevents fabricating paths for sibling directories.
  it('never mistakes a sibling directory for the root', () => {
    const rewrite = createRootPathRewriter('/a/link', '/b/real', 'darwin')
    expect(rewrite('/b/real-backup/x.ts')).toBe('/b/real-backup/x.ts')
    expect(createRootPathRewriter('/a/repo', '/a/repo', 'darwin')('/a/repo-backup/x.ts')).toBe(
      '/a/repo-backup/x.ts'
    )
  })

  it('never mistakes a sibling UNC share directory for the root', () => {
    const rewrite = createRootPathRewriter('\\\\srv\\share\\repo', '\\\\srv\\share\\repo', 'win32')
    expect(rewrite('\\\\srv\\share\\repo2\\x.ts')).toBe('\\\\srv\\share\\repo2\\x.ts')
  })

  // Unicode case folding can change length; segment-wise matching avoids slicing raw characters.
  it('does not fold unrelated scripts into a match', () => {
    const rewrite = createRootPathRewriter('/a/DIYARBAKIR', '/a/DIYARBAKIR', 'darwin')
    expect(rewrite('/a/d\u0131yarbak\u0131r/x.ts')).toBe('/a/d\u0131yarbak\u0131r/x.ts')
  })

  it('folds Unicode composition differences without slicing mid-character', () => {
    const composed = '/Users/dev/caf\u00e9'
    const decomposed = '/Users/dev/cafe\u0301'
    const rewrite = createRootPathRewriter(composed, composed, 'darwin')
    expect(rewrite(`${decomposed}/src/a.ts`)).toBe(`${composed}/src/a.ts`)
  })
})
