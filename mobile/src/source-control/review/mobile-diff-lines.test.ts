import { describe, expect, it } from 'vitest'
import { buildMobileDiffLines } from './mobile-diff-lines'

describe('buildMobileDiffLines', () => {
  it('shows only the edited lines of a file too large for the LCS table', () => {
    const original = Array.from({ length: 450 }, (_, index) => `line-${index + 1}`)
    const modified = ['changed-first', ...original.slice(1, -1), 'changed-last']

    const { lines, truncated } = buildMobileDiffLines(
      `${original.join('\n')}\n`,
      `${modified.join('\n')}\n`
    )

    expect(truncated).toBe(false)
    expect(lines).toHaveLength(452)
    expect(lines.slice(0, 3)).toEqual([
      { kind: 'delete', text: 'line-1', oldLineNumber: 1 },
      { kind: 'add', text: 'changed-first', newLineNumber: 1 },
      { kind: 'context', text: 'line-2', oldLineNumber: 2, newLineNumber: 2 }
    ])
    expect(lines.slice(-2)).toEqual([
      { kind: 'delete', text: 'line-450', oldLineNumber: 450 },
      { kind: 'add', text: 'changed-last', newLineNumber: 450 }
    ])
  })
})
