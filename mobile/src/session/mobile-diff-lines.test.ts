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
})
