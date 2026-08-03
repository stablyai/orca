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
      {
        type: 'file',
        value: 'src/app/Main.tsx',
        target: { pathText: 'src/app/Main.tsx', line: null, column: null }
      },
      { type: 'text', value: ' now' }
    ])
  })

  it('strips a leading ./ in the path but keeps the displayed value', () => {
    const segments = detectFilePathSegments('see ./lib/x.ts')
    expect(segments).toEqual([
      { type: 'text', value: 'see ' },
      {
        type: 'file',
        value: './lib/x.ts',
        target: { pathText: 'lib/x.ts', line: null, column: null }
      }
    ])
  })

  it('keeps ../ parent-relative paths intact', () => {
    const segments = detectFilePathSegments('../shared/util.ts')
    expect(segments).toEqual([
      {
        type: 'file',
        value: '../shared/util.ts',
        target: { pathText: '../shared/util.ts', line: null, column: null }
      }
    ])
  })

  it('detects multiple paths in one run', () => {
    const segments = detectFilePathSegments('a/b.ts and c/d/e.json')
    expect(segments.filter((s) => s.type === 'file')).toEqual([
      {
        type: 'file',
        value: 'a/b.ts',
        target: { pathText: 'a/b.ts', line: null, column: null }
      },
      {
        type: 'file',
        value: 'c/d/e.json',
        target: { pathText: 'c/d/e.json', line: null, column: null }
      }
    ])
  })

  it('detects adjacent paths without punctuation between them', () => {
    expect(
      detectFilePathSegments('src/a.ts src/b.ts')
        .filter((segment) => segment.type === 'file')
        .map((segment) => segment.target.pathText)
    ).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('decodes percent escapes in prose path targets', () => {
    expect(detectFilePathSegments('docs/My%20File.ts')).toEqual([
      {
        type: 'file',
        value: 'docs/My%20File.ts',
        target: { pathText: 'docs/My File.ts', line: null, column: null }
      }
    ])
  })

  it('detects Unicode path segments', () => {
    expect(detectFilePathSegments('src/écran.ts')).toEqual([
      {
        type: 'file',
        value: 'src/écran.ts',
        target: { pathText: 'src/écran.ts', line: null, column: null }
      }
    ])
    expect(detectFilePathSegments(String.raw`src\画面.ts`)).toEqual([
      {
        type: 'file',
        value: String.raw`src\画面.ts`,
        target: { pathText: String.raw`src\画面.ts`, line: null, column: null }
      }
    ])
  })

  it('detects Windows relative, drive, and UNC paths', () => {
    const segments = detectFilePathSegments(
      String.raw`Edit src\app\Main.tsx, C:\repo\config.json, and \\server\share\docs\readme.md`
    )

    expect(segments.filter((segment) => segment.type === 'file')).toEqual([
      {
        type: 'file',
        value: String.raw`src\app\Main.tsx`,
        target: {
          pathText: String.raw`src\app\Main.tsx`,
          line: null,
          column: null
        }
      },
      {
        type: 'file',
        value: String.raw`C:\repo\config.json`,
        target: {
          pathText: String.raw`C:\repo\config.json`,
          line: null,
          column: null
        }
      },
      {
        type: 'file',
        value: String.raw`\\server\share\docs\readme.md`,
        target: {
          pathText: String.raw`\\server\share\docs\readme.md`,
          line: null,
          column: null
        }
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

  it('does not match domain-like path text', () => {
    for (const text of ['example.com/foo.ts', 'docs.rs/serde/index.ts', 'www.example.com/x.md']) {
      expect(detectFilePathSegments(text)).toEqual([{ type: 'text', value: text }])
    }
  })

  it('trims prose punctuation without changing route delimiters', () => {
    expect(detectFilePathSegments('See (src/app.ts), then [src/other.ts].')).toEqual([
      { type: 'text', value: 'See (' },
      {
        type: 'file',
        value: 'src/app.ts',
        target: { pathText: 'src/app.ts', line: null, column: null }
      },
      { type: 'text', value: '), then [' },
      {
        type: 'file',
        value: 'src/other.ts',
        target: { pathText: 'src/other.ts', line: null, column: null }
      },
      { type: 'text', value: '].' }
    ])
    expect(detectFilePathSegments('mobile/app/(shop)/[id]/page.tsx')).toEqual([
      {
        type: 'file',
        value: 'mobile/app/(shop)/[id]/page.tsx',
        target: {
          pathText: 'mobile/app/(shop)/[id]/page.tsx',
          line: null,
          column: null
        }
      }
    ])
    expect(detectFilePathSegments('[id]/page.tsx')).toEqual([
      {
        type: 'file',
        value: '[id]/page.tsx',
        target: { pathText: '[id]/page.tsx', line: null, column: null }
      }
    ])
    expect(detectFilePathSegments('(shop)/page.tsx')).toEqual([
      {
        type: 'file',
        value: '(shop)/page.tsx',
        target: { pathText: '(shop)/page.tsx', line: null, column: null }
      }
    ])
  })

  it('does not partially link spaced or range paths', () => {
    for (const text of [
      '/Users/me/My Project/src/app.ts',
      String.raw`C:\Program Files\repo\app.ts`,
      'My Project/src/app.ts',
      'src/app.ts:12-14',
      'src/app.ts:12:3-8',
      'foo(src/app.ts)'
    ]) {
      expect(detectFilePathSegments(text)).toEqual([{ type: 'text', value: text }])
    }
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

  it('detects scoped-package file paths with a segment-leading @', () => {
    expect(detectFilePathSegments('open @types/react/index.d.ts here')).toEqual([
      { type: 'text', value: 'open ' },
      {
        type: 'file',
        value: '@types/react/index.d.ts',
        target: { pathText: '@types/react/index.d.ts', line: null, column: null }
      },
      { type: 'text', value: ' here' }
    ])
    expect(
      detectFilePathSegments('node_modules/@scope/pkg/file.ts').filter((s) => s.type === 'file')
    ).toEqual([
      {
        type: 'file',
        value: 'node_modules/@scope/pkg/file.ts',
        target: {
          pathText: 'node_modules/@scope/pkg/file.ts',
          line: null,
          column: null
        }
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

  it('returns a single text segment when the run has no dot', () => {
    const text = 'a/'.repeat(8192)
    expect(detectFilePathSegments(text)).toEqual([{ type: 'text', value: text }])
  })

  it('skips detection for runs over the length cap even with dots', () => {
    // 'a.b/'-repeats pass the dot precheck, so this exercises the length cap that
    // bounds CANDIDATE_PATTERN's worst-case backtracking.
    const text = 'a.b/'.repeat(2000)
    expect(detectFilePathSegments(text)).toEqual([{ type: 'text', value: text }])
  })

  it('still detects a path in a long-but-under-cap run', () => {
    const prefix = 'context '.repeat(200)
    const segments = detectFilePathSegments(`${prefix}src/app/Main.tsx`)
    expect(segments.filter((s) => s.type === 'file')).toEqual([
      {
        type: 'file',
        value: 'src/app/Main.tsx',
        target: { pathText: 'src/app/Main.tsx', line: null, column: null }
      }
    ])
  })

  it('detects an absolute POSIX path', () => {
    const path =
      '/Users/jinjingliang/Documents/projects/orca/worktree/docs/native-chat-rendering-architecture.md'
    expect(detectFilePathSegments(`Open ${path}`)).toEqual([
      { type: 'text', value: 'Open ' },
      {
        type: 'file',
        value: path,
        target: { pathText: path, line: null, column: null }
      }
    ])
  })

  it('preserves line and column in the tap target', () => {
    expect(detectFilePathSegments('See mobile/src/app.tsx:42:7')).toEqual([
      { type: 'text', value: 'See ' },
      {
        type: 'file',
        value: 'mobile/src/app.tsx:42:7',
        target: { pathText: 'mobile/src/app.tsx', line: 42, column: 7 }
      }
    ])
  })

  it('detects bracketed route segments', () => {
    const path = 'mobile/app/h/[hostId]/session/[worktreeId].tsx'
    expect(detectFilePathSegments(path)).toEqual([
      {
        type: 'file',
        value: path,
        target: { pathText: path, line: null, column: null }
      }
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

  it('accepts single-line spaced paths in code spans', () => {
    expect(isFilePathCodeSpan('docs/My File.md')).toBe(true)
    expect(isFilePathCodeSpan(String.raw`C:\Program Files\app.ts`)).toBe(true)
  })

  it('accepts a bare filename code span', () => {
    expect(isFilePathCodeSpan('package.json')).toBe(true)
  })

  it('accepts explicit extensionless, dotfile, and custom-extension paths', () => {
    expect(isFilePathCodeSpan('Dockerfile')).toBe(true)
    expect(isFilePathCodeSpan('infra/Makefile')).toBe(true)
    expect(isFilePathCodeSpan('repo/.gitignore')).toBe(true)
    expect(isFilePathCodeSpan('build/output.customext')).toBe(true)
  })

  it('rejects multi-word code spans', () => {
    expect(isFilePathCodeSpan('npm run build')).toBe(false)
    expect(isFilePathCodeSpan('docs/My File.md\nnext')).toBe(false)
  })

  it('rejects non-file code spans', () => {
    expect(isFilePathCodeSpan('someVariable')).toBe(false)
    expect(isFilePathCodeSpan('path/to/1.2.3')).toBe(false)
  })

  it('rejects urls in code spans', () => {
    expect(isFilePathCodeSpan('https://x.com/a.ts')).toBe(false)
  })

  it('accepts scoped-package paths with a segment-leading @', () => {
    expect(isFilePathCodeSpan('@types/react/index.d.ts')).toBe(true)
    expect(isFilePathCodeSpan('node_modules/@scope/pkg/file.ts')).toBe(true)
  })

  it('rejects emails and git URLs with a mid-token @', () => {
    expect(isFilePathCodeSpan('git@github.com:user/repo.git')).toBe(false)
    expect(isFilePathCodeSpan('user@host.com/path/file.txt')).toBe(false)
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
