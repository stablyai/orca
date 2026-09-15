import { describe, expect, it } from 'vitest'
import {
  findManagedTomlBlocks,
  findRecognizedManagedTables,
  stripManagedTomlRegions,
  type ManagedTomlMarkers
} from './managed-toml-ownership'

const START = '# >>> start >>>'
const END = '# <<< end <<<'
const MARKERS: ManagedTomlMarkers = { startMarker: START, endMarker: END }

// Recognizes an `[owned]` table plus its `k = ...` lines; anything else is user text.
const recognizeOwned = (
  lines: readonly string[],
  index: number
): { lineCount: number; value: string } | null => {
  if (lines[index].trim() !== '[owned]') {
    return null
  }
  let cursor = index + 1
  while (cursor < lines.length && /^k\d* = /.test(lines[cursor].trim())) {
    cursor++
  }
  return { lineCount: cursor - index, value: lines[index].trim() }
}

function strip(text: string): string {
  return stripManagedTomlRegions(text, [
    ...findManagedTomlBlocks(text, MARKERS),
    ...findRecognizedManagedTables(text, recognizeOwned)
  ]).text
}

describe('managed TOML marker blocks', () => {
  it('finds nothing in a file without the start marker', () => {
    expect(findManagedTomlBlocks('a = 1\n', MARKERS)).toEqual([])
    expect(stripManagedTomlRegions('a = 1\n', [])).toMatchObject({
      text: 'a = 1\n',
      changed: false
    })
  })

  it('owns everything between the markers regardless of content', () => {
    const text = `a = 1\n\n${START}\n[whatever]\nx = 2\n${END}\nb = 3\n`
    expect(findManagedTomlBlocks(text, MARKERS)[0].terminated).toBe(true)
    expect(strip(text)).toBe('a = 1\nb = 3\n')
  })

  it('an orphaned block owns only its stray marker line', () => {
    const text = `${START}\n[anything]\nkeep = true\n`
    const [region] = findManagedTomlBlocks(text, MARKERS)
    expect(region.terminated).toBe(false)
    expect(stripManagedTomlRegions(text, [region]).text).toBe('[anything]\nkeep = true\n')
  })

  it('does not let a terminated block swallow a later stray start marker', () => {
    const text = `${START}\n[owned]\nk = 1\n${END}\n${START}\n[user]\nkeep = true\n`
    expect(findManagedTomlBlocks(text, MARKERS).map((region) => region.terminated)).toEqual([
      true,
      false
    ])
    expect(strip(text)).toBe('[user]\nkeep = true\n')
  })

  it('absorbs the blank run above the marker without crossing the block above', () => {
    expect(strip(`a = 1\n\n\n${START}\nx\n${END}\n`)).toBe('a = 1\n')
  })

  // CodeRabbit on #20148: a prefix match let a user's own comment open or close
  // a region, deleting every byte between two quoted markers.
  it("ignores a marker line carrying a trailing comment of the user's own", () => {
    const text = [
      'a = 1',
      `${START} (example from the docs)`,
      '[user]',
      'keep = true',
      `${END} (end of example)`,
      'b = 2'
    ].join('\n')
    expect(findManagedTomlBlocks(text, MARKERS)).toEqual([])
    expect(strip(text)).toBe(text)
  })

  it('ignores a marker line with a prefix or altered text', () => {
    for (const near of [`x ${START}`, START.replace('>>>', '>>'), `${START}x`]) {
      expect(findManagedTomlBlocks(`${near}\n[user]\nkeep = true\n`, MARKERS)).toEqual([])
    }
  })

  it('still matches a marker indented or with trailing whitespace', () => {
    const text = `a = 1\n   ${START}   \n[owned]\nk = 1\n  ${END}\nb = 2\n`
    expect(findManagedTomlBlocks(text, MARKERS)[0].terminated).toBe(true)
    expect(strip(text)).toBe('a = 1\nb = 2\n')
  })

  it('handles a marker on the last line with no trailing newline', () => {
    expect(strip(`a = 1\n${START}`)).toBe('a = 1\n')
    expect(strip(`a = 1\n${START}\n[owned]\nk = 1`)).toBe('a = 1\n')
  })
})

describe('recognized managed tables', () => {
  it('reclaims a recognized table wherever it sits, and nothing else', () => {
    const text = `[user]\nkeep = true\n\n[owned]\nk = 1\nk2 = 2\n\n[user2]\nalso = true\n`
    expect(findRecognizedManagedTables(text, recognizeOwned)).toHaveLength(1)
    expect(strip(text)).toBe('[user]\nkeep = true\n\n[user2]\nalso = true\n')
  })

  it('reclaims tables stranded below user text after an orphaned marker', () => {
    const text = `${START}\n[owned]\nk = 1\n[user]\nkeep = true\n[owned]\nk = 2\n`
    expect(strip(text)).toBe('[user]\nkeep = true\n')
  })

  it('leaves an unrecognized table alone', () => {
    const text = `${START}\n[user]\nkeep = true\n`
    expect(strip(text)).toBe('[user]\nkeep = true\n')
  })

  it('reports each recognized table to readers', () => {
    const text = `[owned]\nk = 1\n[user]\nx = 1\n[owned]\nk = 2\n`
    expect(findRecognizedManagedTables(text, recognizeOwned).map((t) => t.value)).toEqual([
      '[owned]',
      '[owned]'
    ])
  })

  it('clamps a recognizer that claims more lines than the file has', () => {
    const greedy = (): { lineCount: number; value: null } => ({ lineCount: 999, value: null })
    const text = 'a = 1\n'
    expect(stripManagedTomlRegions(text, findRecognizedManagedTables(text, greedy)).text).toBe('')
  })
})

describe('splicing owned regions', () => {
  it('merges a recognized table nested inside a marker block', () => {
    const text = `a = 1\n${START}\n[owned]\nk = 1\n${END}\nb = 2\n`
    const regions = [
      ...findManagedTomlBlocks(text, MARKERS),
      ...findRecognizedManagedTables(text, recognizeOwned)
    ]
    expect(regions).toHaveLength(2)
    expect(stripManagedTomlRegions(text, regions).text).toBe('a = 1\nb = 2\n')
  })

  it('splices CRLF text back verbatim', () => {
    expect(strip(`a = 1\r\n\r\n${START}\r\n[owned]\r\nk = 1\r\n${END}\r\nb = 2\r\n`)).toBe(
      'a = 1\r\nb = 2\r\n'
    )
    expect(strip(`${START}\r\n[owned]\r\nk = 1\r\n[user]\r\nkeep = true\r\n`)).toBe(
      '[user]\r\nkeep = true\r\n'
    )
  })
})
