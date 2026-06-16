import { describe, expect, it } from 'vitest'
import { matchFilePathAtColumn, parsePathWithOptionalLineColumn } from './terminal-path-tap'

// Returns the column of the first occurrence of `needle` in `line` (+offset).
function colOf(line: string, needle: string, offset = 0): number {
  return line.indexOf(needle) + offset
}

describe('parsePathWithOptionalLineColumn', () => {
  it('splits trailing :line:col suffixes', () => {
    expect(parsePathWithOptionalLineColumn('src/a.ts')).toEqual({
      pathText: 'src/a.ts',
      line: null,
      column: null
    })
    expect(parsePathWithOptionalLineColumn('src/a.ts:42')).toEqual({
      pathText: 'src/a.ts',
      line: 42,
      column: null
    })
    expect(parsePathWithOptionalLineColumn('src/a.ts:42:7')).toEqual({
      pathText: 'src/a.ts',
      line: 42,
      column: 7
    })
  })

  it('rejects directory-only and zero line/col', () => {
    expect(parsePathWithOptionalLineColumn('src/')).toBeNull()
    expect(parsePathWithOptionalLineColumn('src/a.ts:0')).toBeNull()
  })
})

describe('matchFilePathAtColumn', () => {
  it('matches an absolute path under the tap', () => {
    const line = 'created /tmp/out/report.html for you'
    const result = matchFilePathAtColumn(line, colOf(line, 'report'))
    expect(result?.pathText).toBe('/tmp/out/report.html')
  })

  it('matches a relative path and parses line:col', () => {
    const line = 'see src/components/Button.tsx:12:7 here'
    const result = matchFilePathAtColumn(line, colOf(line, 'Button'))
    expect(result).toEqual({ pathText: 'src/components/Button.tsx', line: 12, column: 7 })
  })

  it('matches a tilde path', () => {
    const line = 'wrote ~/Documents/notes.md'
    const result = matchFilePathAtColumn(line, colOf(line, 'notes'))
    expect(result?.pathText).toBe('~/Documents/notes.md')
  })

  it('yields the tight whitespace-bounded segment under the tap', () => {
    // On a path whose dir name has a space, tapping the file segment yields the
    // openable sub-path after the space (still resolves against the worktree).
    const line = '/Users/me/My Project/readme.md done'
    const result = matchFilePathAtColumn(line, colOf(line, 'readme'))
    expect(result?.pathText).toBe('Project/readme.md')
  })

  it('trims surrounding punctuation', () => {
    const line = 'open (src/a.ts) now'
    const result = matchFilePathAtColumn(line, colOf(line, 'a.ts'))
    expect(result?.pathText).toBe('src/a.ts')
  })

  it('returns null when the tap is not on a path', () => {
    const line = 'just some prose with no path here'
    expect(matchFilePathAtColumn(line, colOf(line, 'prose'))).toBeNull()
  })

  it('returns null when the tap is left of the path span', () => {
    const line = 'prefix /tmp/x.ts'
    expect(matchFilePathAtColumn(line, 0)).toBeNull()
  })

  it('matches a bare filename with an extension (no slash)', () => {
    // Why: agents commonly print a bare filename (e.g. a markdown link whose
    // target was consumed). The host existence-check rejects non-files.
    const line = '• Here you go: README.md'
    const result = matchFilePathAtColumn(line, colOf(line, 'README'))
    expect(result?.pathText).toBe('README.md')
  })

  it('does not match a plain word without an extension', () => {
    const line = '• Here you go: README.md'
    expect(matchFilePathAtColumn(line, colOf(line, 'Here'))).toBeNull()
  })
})
