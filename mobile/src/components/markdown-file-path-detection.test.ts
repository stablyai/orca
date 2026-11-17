import { describe, expect, it } from 'vitest'
import { detectFilePathSegments, isFilePathCodeSpan } from './markdown-file-path-detection'

describe('detectFilePathSegments', () => {
  it('detects Windows relative, drive, and UNC paths', () => {
    const segments = detectFilePathSegments(
      String.raw`Edit src\app\Main.tsx, C:\repo\config.json, and \\server\share\docs\readme.md`
    )

    expect(segments.filter((segment) => segment.type === 'file')).toEqual([
      { type: 'file', value: String.raw`src\app\Main.tsx`, path: String.raw`src\app\Main.tsx` },
      {
        type: 'file',
        value: String.raw`C:\repo\config.json`,
        path: String.raw`C:\repo\config.json`
      },
      {
        type: 'file',
        value: String.raw`\\server\share\docs\readme.md`,
        path: String.raw`\\server\share\docs\readme.md`
      }
    ])
  })

  it('detects POSIX absolute paths', () => {
    expect(detectFilePathSegments('Wrote /Users/me/wt/src/app.tsx today')).toEqual([
      { type: 'text', value: 'Wrote ' },
      { type: 'file', value: '/Users/me/wt/src/app.tsx', path: '/Users/me/wt/src/app.tsx' },
      { type: 'text', value: ' today' }
    ])
    expect(detectFilePathSegments('/repo/src/index.ts')).toEqual([
      { type: 'file', value: '/repo/src/index.ts', path: '/repo/src/index.ts' }
    ])
    expect(detectFilePathSegments('/root.ts')).toEqual([
      { type: 'file', value: '/root.ts', path: '/root.ts' }
    ])
  })

  it('detects paths with :line and :line:col suffixes', () => {
    expect(detectFilePathSegments('see src/foo.ts:42 here')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'file', value: 'src/foo.ts:42', path: 'src/foo.ts:42' },
      { type: 'text', value: ' here' }
    ])
    expect(
      detectFilePathSegments('/wt/src/app.tsx:120:7 and C:\\repo\\a.ts:3').filter(
        (s) => s.type === 'file'
      )
    ).toEqual([
      { type: 'file', value: '/wt/src/app.tsx:120:7', path: '/wt/src/app.tsx:120:7' },
      { type: 'file', value: 'C:\\repo\\a.ts:3', path: 'C:\\repo\\a.ts:3' }
    ])
  })

  it('does not partially parse numeric-looking non-line tails', () => {
    expect(detectFilePathSegments('log src/app.ts:1e3 oops')).toEqual([
      { type: 'text', value: 'log ' },
      { type: 'file', value: 'src/app.ts', path: 'src/app.ts' },
      { type: 'text', value: ':1e3 oops' }
    ])
    expect(detectFilePathSegments('coverage src/app.ts:80% of lines')).toEqual([
      { type: 'text', value: 'coverage ' },
      { type: 'file', value: 'src/app.ts', path: 'src/app.ts' },
      { type: 'text', value: ':80% of lines' }
    ])
  })

  it('does not match URLs', () => {
    expect(detectFilePathSegments('https://example.com/path/file.ts')).toEqual([
      { type: 'text', value: 'https://example.com/path/file.ts' }
    ])
    expect(detectFilePathSegments('see https://example.com/path/file.ts:42 now')).toEqual([
      { type: 'text', value: 'see https://example.com/path/file.ts:42 now' }
    ])
  })

  it('does not match protocol-relative URLs', () => {
    expect(detectFilePathSegments('load //cdn.example.com/lib/app.js')).toEqual([
      { type: 'text', value: 'load //cdn.example.com/lib/app.js' }
    ])
  })

  it('detects scoped-package file paths with a segment-leading @', () => {
    expect(detectFilePathSegments('open @types/react/index.d.ts here')).toEqual([
      { type: 'text', value: 'open ' },
      {
        type: 'file',
        value: '@types/react/index.d.ts',
        path: '@types/react/index.d.ts'
      },
      { type: 'text', value: ' here' }
    ])
    expect(
      detectFilePathSegments('node_modules/@scope/pkg/file.ts').filter((s) => s.type === 'file')
    ).toEqual([
      {
        type: 'file',
        value: 'node_modules/@scope/pkg/file.ts',
        path: 'node_modules/@scope/pkg/file.ts'
      }
    ])
  })

  it('does not match emails or git URLs with a mid-token @', () => {
    expect(detectFilePathSegments('clone git@github.com:user/repo.git')).toEqual([
      { type: 'text', value: 'clone git@github.com:user/repo.git' }
    ])
    expect(detectFilePathSegments('open user@host.com/path/file.txt')).toEqual([
      { type: 'text', value: 'open user@host.com/path/file.txt' }
    ])
  })

  it('skips detection for runs over the length cap even with dots', () => {
    // Dot-heavy repeats pass dot precheck; length cap must still bound regex backtracking.
    const text = 'a.b/'.repeat(2000)
    expect(detectFilePathSegments(text)).toEqual([{ type: 'text', value: text }])
  })
})

describe('isFilePathCodeSpan', () => {
  it('accepts POSIX absolute paths and :line citations', () => {
    expect(isFilePathCodeSpan('/Users/me/wt/src/app.tsx')).toBe(true)
    expect(isFilePathCodeSpan('src/foo.ts:42')).toBe(true)
    expect(isFilePathCodeSpan('src/foo.ts:42:7')).toBe(true)
    expect(isFilePathCodeSpan('MobileNativeChatComposer.tsx:23')).toBe(true)
    expect(isFilePathCodeSpan(String.raw`C:\repo\Main.tsx:12`)).toBe(true)
  })
})
