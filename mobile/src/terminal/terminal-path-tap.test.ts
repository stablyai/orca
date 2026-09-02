import { Script, createContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES,
  columnForTerminalFileLinkTap
} from '../../../src/shared/terminal-file-link-conformance'
import { TERMINAL_PATH_TAP_JS } from './terminal-path-tap-injected'
import { matchFilePathAtColumn, parsePathWithOptionalLineColumn } from './terminal-path-tap'

type InjectedPathMatcher = typeof matchFilePathAtColumn

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
  it.each(TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES)(
    'matches shared terminal file-link tap case: $name',
    (testCase) => {
      expect(
        matchFilePathAtColumn(testCase.lineText, columnForTerminalFileLinkTap(testCase))
      ).toEqual(testCase.expected)
    }
  )

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

  it('matches a path whose directory name contains a space', () => {
    const line = '/Users/me/My Project/readme.md done'
    const result = matchFilePathAtColumn(line, colOf(line, 'readme'))
    expect(result?.pathText).toBe('/Users/me/My Project/readme.md')
  })

  it('matches a spaced path with line and column suffixes', () => {
    const line = 'wrote /tmp/orca report/result.json:12:3 for you'
    const result = matchFilePathAtColumn(line, colOf(line, 'result'))
    expect(result).toEqual({
      pathText: '/tmp/orca report/result.json',
      line: 12,
      column: 3
    })
  })

  it('matches a spaced path when an earlier directory segment contains a dot', () => {
    const line = 'wrote /tmp/v1.2 reports/result.json for you'
    expect(matchFilePathAtColumn(line, colOf(line, 'v1.2'))).toEqual({
      pathText: '/tmp/v1.2 reports/result.json',
      line: null,
      column: null
    })
    expect(matchFilePathAtColumn(line, colOf(line, 'reports'))).toEqual({
      pathText: '/tmp/v1.2 reports/result.json',
      line: null,
      column: null
    })
    expect(matchFilePathAtColumn(line, colOf(line, 'result'))).toEqual({
      pathText: '/tmp/v1.2 reports/result.json',
      line: null,
      column: null
    })
  })

  it('matches a path whose final filename contains a space', () => {
    const line = 'wrote /tmp/final report.json for you'
    expect(matchFilePathAtColumn(line, colOf(line, 'final'))).toEqual({
      pathText: '/tmp/final report.json',
      line: null,
      column: null
    })

    expect(matchFilePathAtColumn(line, colOf(line, 'report'))).toEqual({
      pathText: '/tmp/final report.json',
      line: null,
      column: null
    })
  })

  it('does not merge two spaced path candidates through prose', () => {
    const line = 'see /tmp/a.txt and /tmp/b.txt done'
    expect(matchFilePathAtColumn(line, colOf(line, 'a.txt'))).toEqual({
      pathText: '/tmp/a.txt',
      line: null,
      column: null
    })
    expect(matchFilePathAtColumn(line, colOf(line, 'b.txt'))).toEqual({
      pathText: '/tmp/b.txt',
      line: null,
      column: null
    })
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

  it('returns null when the tap is immediately after the path span', () => {
    const line = 'prefix /tmp/x.ts next'
    expect(matchFilePathAtColumn(line, line.indexOf(' next'))).toBeNull()
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

describe('injected matchFilePathAtColumn', () => {
  const matcher = createInjectedPathMatcher()

  it.each(TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES)(
    'matches shared terminal file-link tap case: $name',
    (testCase) => {
      expect(matcher(testCase.lineText, columnForTerminalFileLinkTap(testCase))).toEqual(
        testCase.expected
      )
    }
  )
})

function createInjectedPathMatcher(): InjectedPathMatcher {
  const context = createContext({})
  new Script(
    `${TERMINAL_PATH_TAP_JS}\nthis.__matchFilePathAtColumn = matchFilePathAtColumn;`
  ).runInContext(context)
  return (context as { __matchFilePathAtColumn: InjectedPathMatcher }).__matchFilePathAtColumn
}
