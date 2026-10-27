import { describe, expect, it } from 'vitest'
import {
  TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES,
  columnForTerminalFileLinkTap
} from '../../../src/shared/terminal-file-link-conformance'
import { filePathCandidatesAtColumn } from './document/path-tap'
import { parsePathWithOptionalLineColumn } from './terminal-path-tap'

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

// Taps offer every reading, longest first; the host opens the first that exists.
describe('filePathCandidatesAtColumn', () => {
  it.each(TERMINAL_FILE_LINK_TAP_CONFORMANCE_CASES)(
    'offers shared terminal file-link tap case: $name',
    (testCase) => {
      const candidates = filePathCandidatesAtColumn(
        testCase.lineText,
        columnForTerminalFileLinkTap(testCase)
      )
      if (testCase.expected) {
        expect(candidates).toContainEqual(testCase.expected)
      } else {
        expect(candidates).toEqual([])
      }
    }
  )

  it('tries a spaced reading before the plain path it extends', () => {
    const line = 'wrote /tmp/v1.2 reports/result.json for you'
    expect(filePathCandidatesAtColumn(line, colOf(line, 'v1.2'))[0]?.pathText).toBe(
      '/tmp/v1.2 reports/result.json'
    )
  })

  it('offers the plain path when prose with a separator follows it', () => {
    const line = 'Wrote ~/notes/plan.md. It covers setup and/or teardown.'
    expect(filePathCandidatesAtColumn(line, colOf(line, 'plan'))).toEqual([
      { pathText: '~/notes/plan.md', line: null, column: null }
    ])
  })

  it('leaves taps on prose after a path to the terminal', () => {
    const prompt = 'me@host:~/proj$ git status'
    expect(filePathCandidatesAtColumn(prompt, colOf(prompt, 'git'))).toEqual([])
    const line = 'ls /tmp/My Folder then done'
    expect(filePathCandidatesAtColumn(line, colOf(line, 'done'))).toEqual([])
  })

  it('offers nothing beside the path span', () => {
    expect(filePathCandidatesAtColumn('prefix /tmp/x.ts', 0)).toEqual([])
    const line = 'prefix /tmp/x.ts next'
    expect(filePathCandidatesAtColumn(line, line.indexOf(' next'))).toEqual([])
  })

  it('offers a bare filename with an extension but not a plain word', () => {
    const line = '• Here you go: README.md'
    expect(filePathCandidatesAtColumn(line, colOf(line, 'README'))[0]?.pathText).toBe('README.md')
    expect(filePathCandidatesAtColumn(line, colOf(line, 'Here'))).toEqual([])
  })
})
