import { describe, expect, it } from 'vitest'
import type { MobileDiffLine } from './mobile-diff-lines'
import {
  buildMobileDiffHunks,
  findNextMobileDiffHunkIndex,
  findPreviousMobileDiffHunkIndex
} from './mobile-diff-hunks'

const lines: MobileDiffLine[] = [
  { kind: 'context', text: 'one', oldLineNumber: 1, newLineNumber: 1 },
  { kind: 'delete', text: 'two', oldLineNumber: 2 },
  { kind: 'add', text: 'TWO', newLineNumber: 2 },
  { kind: 'context', text: 'three', oldLineNumber: 3, newLineNumber: 3 },
  { kind: 'add', text: 'four', newLineNumber: 4 }
]

describe('mobile diff hunks', () => {
  it('extracts contiguous changed lines as hunks', () => {
    expect(buildMobileDiffHunks(lines)).toEqual([
      {
        index: 0,
        startIndex: 1,
        endIndex: 2,
        addedLines: 1,
        deletedLines: 1,
        firstLineNumber: 2
      },
      {
        index: 1,
        startIndex: 4,
        endIndex: 4,
        addedLines: 1,
        deletedLines: 0,
        firstLineNumber: 4
      }
    ])
  })

  it('wraps next and previous hunk navigation', () => {
    const hunks = buildMobileDiffHunks(lines)

    expect(findNextMobileDiffHunkIndex(hunks, 1)).toBe(1)
    expect(findNextMobileDiffHunkIndex(hunks, 4)).toBe(0)
    expect(findPreviousMobileDiffHunkIndex(hunks, 4)).toBe(0)
    expect(findPreviousMobileDiffHunkIndex(hunks, 1)).toBe(1)
  })
})
