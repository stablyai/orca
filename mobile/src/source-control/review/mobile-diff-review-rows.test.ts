import { describe, expect, it } from 'vitest'
import type { MobileDiffLine } from './mobile-diff-lines'
import { foldEnclosingLine } from './mobile-diff-review-rows'

const context = (text: string): MobileDiffLine => ({ kind: 'context', text })

describe('foldEnclosingLine', () => {
  it('names the nearest line above the fold that is indented less than the line after it', () => {
    const lines: MobileDiffLine[] = [
      context("describe('queue', () => {"),
      context("  it('orders files', () => {"),
      context('    const queue = build()'),
      context(''),
      context('    expect(queue).toHaveLength(3)'),
      { kind: 'delete', text: '  removed()' },
      context('    expect(queue[0].scope).toBe(1)')
    ]
    expect(foldEnclosingLine(lines, 6)).toBe("it('orders files', () => {")
  })

  it('skips blank lines after the fold and returns null when nothing encloses it', () => {
    const lines = [
      context('const a = 1'),
      context('const b = 2'),
      context(''),
      context('const c = 3')
    ]
    expect(foldEnclosingLine(lines, 2)).toBeNull()
    expect(foldEnclosingLine(lines, 4)).toBeNull()
  })
})
