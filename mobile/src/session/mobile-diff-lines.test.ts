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

  it('caps add-only preview rows before returning the mobile truncation marker', () => {
    const modified = Array.from({ length: 3_000 }, (_, index) => `line-${index + 1}`).join('\n')

    const result = buildMobileDiffLines('', `${modified}\n`)

    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(2_501)
    expect(result.lines[0]).toEqual({ kind: 'add', text: 'line-1', newLineNumber: 1 })
    expect(result.lines[2_499]).toEqual({ kind: 'add', text: 'line-2500', newLineNumber: 2500 })
    expect(result.lines[2_500]).toEqual({
      kind: 'context',
      text: '... diff truncated for mobile preview ...'
    })
  })

  it('caps prefix-suffix fallback rows for very large changed files', () => {
    const original = Array.from({ length: 3_000 }, (_, index) => `old-${index + 1}`).join('\n')
    const modified = Array.from({ length: 3_000 }, (_, index) => `new-${index + 1}`).join('\n')

    const result = buildMobileDiffLines(`${original}\n`, `${modified}\n`)

    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(2_501)
    expect(result.lines[0]).toEqual({ kind: 'delete', text: 'old-1', oldLineNumber: 1 })
    expect(result.lines[2_499]).toEqual({
      kind: 'delete',
      text: 'old-2500',
      oldLineNumber: 2500
    })
    expect(result.lines[2_500]).toEqual({
      kind: 'context',
      text: '... diff truncated for mobile preview ...'
    })
  })
})
