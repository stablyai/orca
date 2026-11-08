import { describe, expect, it } from 'vitest'
import { buildMobileDiffLines } from './mobile-diff-lines'

describe('buildMobileDiffLines', () => {
  it('marks added, deleted, and unchanged lines', () => {
    const result = buildMobileDiffLines('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n')

    expect(result.truncated).toBe(false)
    expect(result.lines).toEqual([
      { kind: 'context', text: 'one', oldLineNumber: 1, newLineNumber: 1 },
      { kind: 'delete', text: 'two', oldLineNumber: 2 },
      { kind: 'add', text: 'TWO', newLineNumber: 2 },
      { kind: 'context', text: 'three', oldLineNumber: 3, newLineNumber: 3 },
      { kind: 'add', text: 'four', newLineNumber: 4 }
    ])
  })

  it('hides a re-indent unless whitespace is shown, like desktop', () => {
    const original = 'if (a) {\n  run()\n}\n'
    const modified = 'if (a) {\n    run()\n}\n'
    const kinds = (lines: { kind: string }[]) => lines.map((line) => line.kind)
    expect(
      kinds(buildMobileDiffLines(original, modified, { ignoreTrimWhitespace: true }).lines)
    ).toEqual(['context', 'context', 'context'])
    expect(kinds(buildMobileDiffLines(original, modified).lines)).toEqual([
      'context',
      'delete',
      'add',
      'context'
    ])
  })
})
