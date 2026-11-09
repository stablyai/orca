import { describe, expect, it } from 'vitest'
import { buildMobileDiffLines } from './mobile-diff-lines'

function numberedLines(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)
}

function withTrailingNewline(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

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

  it('keeps unchanged lines when only the ends of a file past the LCS budget change', () => {
    const original = numberedLines(450, 'line')
    const modified = [...original]
    modified[0] = 'changed-first'
    modified[449] = 'changed-last'

    const result = buildMobileDiffLines(
      withTrailingNewline(original),
      withTrailingNewline(modified)
    )

    expect(result.truncated).toBe(false)
    expect(result.lines[0]).toEqual({ kind: 'delete', text: 'line-1', oldLineNumber: 1 })
    expect(result.lines[1]).toEqual({ kind: 'add', text: 'changed-first', newLineNumber: 1 })
    expect(result.lines[2]).toEqual({
      kind: 'context',
      text: 'line-2',
      oldLineNumber: 2,
      newLineNumber: 2
    })
    expect(result.lines.at(-2)).toEqual({ kind: 'delete', text: 'line-450', oldLineNumber: 450 })
    expect(result.lines.at(-1)).toEqual({
      kind: 'add',
      text: 'changed-last',
      newLineNumber: 450
    })
    expect(result.lines.filter((line) => line.kind === 'delete')).toHaveLength(2)
    expect(result.lines.filter((line) => line.kind === 'add')).toHaveLength(2)
  })

  it('keeps the unchanged middle between two distant edits in a large file', () => {
    const original = numberedLines(500, 'row')
    const modified = [...original]
    modified[19] = 'changed-20'
    modified[399] = 'changed-400'

    const result = buildMobileDiffLines(
      withTrailingNewline(original),
      withTrailingNewline(modified)
    )
    const deletes = result.lines.filter((line) => line.kind === 'delete').map((line) => line.text)
    const adds = result.lines.filter((line) => line.kind === 'add').map((line) => line.text)

    expect(result.truncated).toBe(false)
    expect(deletes).toEqual(['row-20', 'row-400'])
    expect(adds).toEqual(['changed-20', 'changed-400'])
    expect(result.lines).toContainEqual({
      kind: 'context',
      text: 'row-21',
      oldLineNumber: 21,
      newLineNumber: 21
    })
    expect(result.lines).toContainEqual({
      kind: 'context',
      text: 'row-399',
      oldLineNumber: 399,
      newLineNumber: 399
    })
  })

  it('keeps a trim-only unique line when whitespace is hidden on a large file', () => {
    const original = numberedLines(450, 'line')
    const modified = [...original]
    modified[0] = 'changed-first'
    modified[199] = 'line-200  '
    modified[449] = 'changed-last'

    const result = buildMobileDiffLines(
      withTrailingNewline(original),
      withTrailingNewline(modified),
      { ignoreTrimWhitespace: true }
    )

    expect(result.truncated).toBe(false)
    expect(result.lines.filter((line) => line.kind === 'delete').map((line) => line.text)).toEqual([
      'line-1',
      'line-450'
    ])
    expect(result.lines).toContainEqual({
      kind: 'context',
      text: 'line-200  ',
      oldLineNumber: 200,
      newLineNumber: 200
    })
  })
})
