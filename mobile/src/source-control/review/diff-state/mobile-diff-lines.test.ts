import { describe, expect, it } from 'vitest'
import { buildMobileDiffLines } from './mobile-diff-lines'

describe('buildMobileDiffLines', () => {
  it('preserves unchanged sections when a large diff exceeds the edit budget', () => {
    const original = Array.from({ length: 600 }, (_, index) => `line-${index + 1}`)
    const modified = [
      ...Array.from({ length: 134 }, (_, index) => `header-${index}`),
      ...original.slice(0, 300),
      ...Array.from({ length: 133 }, (_, index) => `middle-${index}`),
      ...original.slice(300, 486)
    ]

    const { lines, truncated } = buildMobileDiffLines(original.join('\n'), modified.join('\n'))

    expect(truncated).toBe(false)
    expect(lines.filter((line) => line.kind === 'add')).toHaveLength(267)
    expect(lines.filter((line) => line.kind === 'delete')).toHaveLength(114)
    expect(lines[134]).toEqual({
      kind: 'context',
      text: 'line-1',
      oldLineNumber: 1,
      newLineNumber: 135
    })
    expect(lines[567]).toEqual({
      kind: 'context',
      text: 'line-301',
      oldLineNumber: 301,
      newLineNumber: 568
    })
    expect(lines[753]).toEqual({ kind: 'delete', text: 'line-487', oldLineNumber: 487 })
  })

  it('preserves distant edits and unchanged context in a large file', () => {
    const original = Array.from({ length: 10_000 }, (_, index) => `line-${index + 1}`)
    const modified = ['changed-first', ...original.slice(1, -1), 'changed-last']

    const { lines, truncated } = buildMobileDiffLines(
      `${original.join('\n')}\n`,
      `${modified.join('\n')}\n`
    )

    expect(truncated).toBe(false)
    expect(lines).toHaveLength(10_002)
    expect(lines.slice(0, 3)).toEqual([
      { kind: 'delete', text: 'line-1', oldLineNumber: 1 },
      { kind: 'add', text: 'changed-first', newLineNumber: 1 },
      { kind: 'context', text: 'line-2', oldLineNumber: 2, newLineNumber: 2 }
    ])
    expect(lines.slice(-2)).toEqual([
      { kind: 'delete', text: 'line-10000', oldLineNumber: 10_000 },
      { kind: 'add', text: 'changed-last', newLineNumber: 10_000 }
    ])
  })
})
