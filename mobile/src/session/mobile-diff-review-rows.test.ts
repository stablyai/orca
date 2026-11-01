import { describe, expect, it } from 'vitest'
import type { MobileDiffLine } from './mobile-diff-lines'
import { buildMobileDiffReviewRows } from './mobile-diff-review-rows'

function lines(pattern: string): MobileDiffLine[] {
  return [...pattern].map((char, index) => ({
    kind: char === '+' ? 'add' : char === '-' ? 'delete' : 'context',
    text: `line ${index}`,
    newLineNumber: index + 1
  }))
}

function shape(pattern: string, opened: number[] = []): string[] {
  return buildMobileDiffReviewRows(lines(pattern), new Set(opened)).map((row) =>
    row.kind === 'fold' ? `fold ${row.hiddenCount}` : row.line.kind.charAt(0)
  )
}

describe('buildMobileDiffReviewRows', () => {
  it('keeps three lines of context beside each change and folds the rest', () => {
    expect(shape('..........+..........-..........')).toEqual([
      'fold 7',
      'c',
      'c',
      'c',
      'a',
      'c',
      'c',
      'c',
      'fold 4',
      'c',
      'c',
      'c',
      'd',
      'c',
      'c',
      'c',
      'fold 7'
    ])
  })

  it('leaves runs too short to fold as lines', () => {
    expect(shape('...+........+')).toEqual(['c', 'c', 'c', 'a', ...Array(8).fill('c'), 'a'])
  })

  it('keeps lines the reader opened open, even after a note splits their run', () => {
    const folded = buildMobileDiffReviewRows(lines(`${'.'.repeat(30)}+`), new Set())
    const fold = folded.find((row) => row.kind === 'fold')
    expect(fold).toMatchObject({ hiddenCount: 27, startIndex: 0, endIndex: 27 })
    const opened = new Set(Array.from({ length: 27 }, (_, index) => index))
    const rows = buildMobileDiffReviewRows(lines(`${'.'.repeat(30)}+`), opened, new Set([11]))
    expect(rows.some((row) => row.kind === 'fold')).toBe(false)
  })

  it('never folds a line that carries a note', () => {
    const rows = buildMobileDiffReviewRows(lines('.'.repeat(20)), new Set(), new Set([10]))
    expect(rows.map((row) => (row.kind === 'fold' ? `fold ${row.hiddenCount}` : 'c'))).toEqual([
      'fold 6',
      ...Array(7).fill('c'),
      'fold 7'
    ])
  })
})
