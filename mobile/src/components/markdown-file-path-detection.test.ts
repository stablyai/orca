import { describe, expect, it } from 'vitest'
import {
  detectFilePathSegments,
  isFilePathCodeSpan,
  normalizeFilePath
} from './markdown-file-path-detection'

describe('detectFilePathSegments', () => {
  it('returns a single text segment when there is no path', () => {
    expect(detectFilePathSegments('just some prose here')).toEqual([
      { type: 'text', value: 'just some prose here' }
    ])
  })

  it('detects a relative source path with surrounding prose', () => {
    const segments = detectFilePathSegments('Edit src/app/Main.tsx now')
    expect(segments).toEqual([
      { type: 'text', value: 'Edit ' },
      { type: 'file', value: 'src/app/Main.tsx', path: 'src/app/Main.tsx' },
      { type: 'text', value: ' now' }
    ])
  })

  it('strips a leading ./ in the path but keeps the displayed value', () => {
    const segments = detectFilePathSegments('see ./lib/x.ts')
    expect(segments).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'file', value: './lib/x.ts', path: 'lib/x.ts' }
    ])
  })

  it('keeps ../ parent-relative paths intact', () => {
    const segments = detectFilePathSegments('../shared/util.ts')
    expect(segments).toEqual([
      { type: 'file', value: '../shared/util.ts', path: '../shared/util.ts' }
    ])
  })

  it('detects multiple paths in one run', () => {
    const segments = detectFilePathSegments('a/b.ts and c/d/e.json')
    expect(segments.filter((s) => s.type === 'file')).toEqual([
      { type: 'file', value: 'a/b.ts', path: 'a/b.ts' },
      { type: 'file', value: 'c/d/e.json', path: 'c/d/e.json' }
    ])
  })

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

  it('does not match bare filenames without a slash', () => {
    expect(detectFilePathSegments('open Main.tsx please')).toEqual([
      { type: 'text', value: 'open Main.tsx please' }
    ])
  })

  it('does not match URLs', () => {
    expect(detectFilePathSegments('https://example.com/path/file.ts')).toEqual([
      { type: 'text', value: 'https://example.com/path/file.ts' }
    ])
  })

  it('does not match version numbers', () => {
    expect(detectFilePathSegments('upgraded to 1.2.3 today')).toEqual([
      { type: 'text', value: 'upgraded to 1.2.3 today' }
    ])
  })

  it('does not match unknown extensions', () => {
    expect(detectFilePathSegments('path/to/thing.whatever')).toEqual([
      { type: 'text', value: 'path/to/thing.whatever' }
    ])
  })

  it('does not match scoped package names', () => {
    expect(detectFilePathSegments('install @scope/pkg.js')).toEqual([
      { type: 'text', value: 'install @scope/pkg.js' }
    ])
  })
})

describe('isFilePathCodeSpan', () => {
  it('accepts a slashed path code span', () => {
    expect(isFilePathCodeSpan('src/app/Main.tsx')).toBe(true)
  })

  it('accepts Windows paths in code spans', () => {
    expect(isFilePathCodeSpan(String.raw`src\app\Main.tsx`)).toBe(true)
    expect(isFilePathCodeSpan(String.raw`C:\repo\Main.tsx`)).toBe(true)
    expect(isFilePathCodeSpan(String.raw`\\server\share\Main.tsx`)).toBe(true)
  })

  it('accepts a bare filename code span', () => {
    expect(isFilePathCodeSpan('package.json')).toBe(true)
  })

  it('rejects multi-word code spans', () => {
    expect(isFilePathCodeSpan('npm run build')).toBe(false)
  })

  it('rejects non-file code spans', () => {
    expect(isFilePathCodeSpan('someVariable')).toBe(false)
  })

  it('rejects urls in code spans', () => {
    expect(isFilePathCodeSpan('https://x.com/a.ts')).toBe(false)
  })
})

describe('normalizeFilePath', () => {
  it('strips a leading ./', () => {
    expect(normalizeFilePath('./a/b.ts')).toBe('a/b.ts')
    expect(normalizeFilePath(String.raw`.\a\b.ts`)).toBe(String.raw`a\b.ts`)
  })

  it('leaves other paths unchanged', () => {
    expect(normalizeFilePath('../a/b.ts')).toBe('../a/b.ts')
    expect(normalizeFilePath('a/b.ts')).toBe('a/b.ts')
  })
})
