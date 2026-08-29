import { describe, expect, it } from 'vitest'
import {
  createRootPathRewriter,
  resolveWatcherRootPaths,
  rewriteWatcherEvents
} from './watcher-event-root-path-rewrite'

describe('createRootPathRewriter', () => {
  it('maps symlink-resolved macOS paths back onto the subscribed root', () => {
    const rewrite = createRootPathRewriter('/tmp/link', '/private/tmp/real', 'darwin')
    expect(rewrite('/private/tmp/real/src/a.ts')).toBe('/tmp/link/src/a.ts')
    expect(rewrite('/private/tmp/real')).toBe('/tmp/link')
  })

  it('maps on-disk casing back onto the subscribed spelling on macOS', () => {
    const rewrite = createRootPathRewriter('/Users/dev/repo', '/Users/dev/repo', 'darwin')
    expect(rewrite('/Users/dev/Repo/src/a.ts')).toBe('/Users/dev/repo/src/a.ts')
  })

  it('keeps paths already spelled like the subscribed root untouched', () => {
    const rewrite = createRootPathRewriter('/tmp/link', '/private/tmp/real', 'darwin')
    const eventPath = '/tmp/link/src/a.ts'
    expect(rewrite(eventPath)).toBe(eventPath)
  })

  it('leaves paths outside the canonical root alone', () => {
    const rewrite = createRootPathRewriter('/tmp/link', '/private/tmp/real', 'darwin')
    expect(rewrite('/private/tmp/other/a.ts')).toBe('/private/tmp/other/a.ts')
  })

  it('stays case-sensitive on Linux', () => {
    const rewrite = createRootPathRewriter('/home/dev/repo', '/home/dev/repo', 'linux')
    expect(rewrite('/home/dev/Repo/src/a.ts')).toBe('/home/dev/Repo/src/a.ts')
  })

  it('does not treat backslash as a separator for POSIX roots', () => {
    const rewrite = createRootPathRewriter('/tmp/link', '/private/tmp/real', 'darwin')
    expect(rewrite('/private/tmp/real/we\\ird/a.ts')).toBe('/tmp/link/we\\ird/a.ts')
  })

  it('rewrites Windows junction targets with the requested drive spelling', () => {
    const rewrite = createRootPathRewriter('C:\\link', 'D:\\real\\repo', 'win32')
    expect(rewrite('D:\\real\\repo\\src\\a.ts')).toBe('C:\\link\\src\\a.ts')
  })

  it('keeps a forward-slash Windows root spelled with forward slashes', () => {
    const rewrite = createRootPathRewriter('C:/link', 'C:\\real\\repo', 'win32')
    expect(rewrite('C:\\real\\repo\\src\\a.ts')).toBe('C:/link/src\\a.ts')
  })

  it('rewrites forward-slash UNC roots on Windows', () => {
    const rewrite = createRootPathRewriter('//srv/share/link', '\\\\srv\\share\\real', 'win32')
    expect(rewrite('\\\\srv\\share\\real\\src\\a.ts')).toBe('//srv/share/link/src\\a.ts')
  })

  // Why: a fabricated path is worse than no fix — a consumer would act on the
  // wrong file — so the prefix match is separator-aware in both directions.
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

  it('rewrites the root itself and leaves a shorter path alone', () => {
    const rewrite = createRootPathRewriter('/a/link', '/b/real', 'darwin')
    expect(rewrite('/b/real')).toBe('/a/link')
    expect(rewrite('/b')).toBe('/b')
  })

  it('restores the requested drive-letter casing', () => {
    const rewrite = createRootPathRewriter('C:\\link', 'c:\\real', 'win32')
    expect(rewrite('c:\\real\\x.ts')).toBe('C:\\link\\x.ts')
  })

  // Why: toLowerCase can change length for some scripts; folding per segment
  // keeps a non-match a non-match instead of slicing the path mid-character.
  it('does not fold unrelated scripts into a match', () => {
    const rewrite = createRootPathRewriter('/a/DIYARBAKIR', '/a/DIYARBAKIR', 'darwin')
    expect(rewrite('/a/d\u0131yarbak\u0131r/x.ts')).toBe('/a/d\u0131yarbak\u0131r/x.ts')
  })

  it('returns a root-only canonical path unrewritten rather than guessing', () => {
    const rewrite = createRootPathRewriter('/a/link', '/', 'darwin')
    expect(rewrite('/x.ts')).toBe('/x.ts')
  })

  it('folds Unicode composition differences without slicing mid-character', () => {
    const composed = '/Users/dev/caf\u00e9'
    const decomposed = '/Users/dev/cafe\u0301'
    const rewrite = createRootPathRewriter(composed, composed, 'darwin')
    expect(rewrite(`${decomposed}/src/a.ts`)).toBe(`${composed}/src/a.ts`)
  })
})

describe('resolveWatcherRootPaths', () => {
  it('falls back to the literal root when realpath fails', () => {
    const { watchRoot, rewriteEventPath } = resolveWatcherRootPaths('/tmp/gone', {
      realpath: () => {
        throw new Error('ENOENT')
      },
      platform: 'linux'
    })
    expect(watchRoot).toBe('/tmp/gone')
    expect(rewriteEventPath('/tmp/gone/a.ts')).toBe('/tmp/gone/a.ts')
  })

  // Why: Linux cannot inotify-watch a symlink at all (IN_ONLYDIR), so the
  // resolved directory — not the caller's spelling — is what gets watched.
  it('watches the resolved root and restores the caller spelling', () => {
    const { watchRoot, rewriteEventPath } = resolveWatcherRootPaths('/tmp/link', {
      realpath: () => '/private/tmp/real',
      platform: 'darwin'
    })
    expect(watchRoot).toBe('/private/tmp/real')
    expect(rewriteEventPath('/private/tmp/real/a.ts')).toBe('/tmp/link/a.ts')
  })
})

describe('rewriteWatcherEvents', () => {
  it('returns the same array when nothing needs rewriting', () => {
    const rewrite = createRootPathRewriter('/tmp/link', '/tmp/link', 'linux')
    const events = [{ path: '/tmp/link/a.ts', type: 'update' as const }]
    expect(rewriteWatcherEvents(events, rewrite)).toBe(events)
  })

  it('rewrites only the events that moved', () => {
    const rewrite = createRootPathRewriter('/tmp/link', '/private/tmp/real', 'darwin')
    const events = [
      { path: '/tmp/link/a.ts', type: 'update' as const },
      { path: '/private/tmp/real/b.ts', type: 'create' as const }
    ]
    expect(rewriteWatcherEvents(events, rewrite)).toEqual([
      { path: '/tmp/link/a.ts', type: 'update' },
      { path: '/tmp/link/b.ts', type: 'create' }
    ])
  })
})
