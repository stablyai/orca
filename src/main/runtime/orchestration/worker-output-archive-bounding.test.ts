import { describe, expect, it } from 'vitest'
import { boundArchiveLines } from './worker-output-archive'

const TERMINAL_ARCHIVE_MAX_CHARS = 262_144

function totalCost(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

describe('boundArchiveLines', () => {
  it('returns the original array untouched when the tail already fits', () => {
    const lines = ['one', 'two', 'three']
    const bounded = boundArchiveLines(lines)
    expect(bounded.truncated).toBe(false)
    expect(bounded.lines).toBe(lines)
  })

  it('keeps the newest lines in order and reports truncation', () => {
    const lines = Array.from({ length: 40_000 }, (_, index) => `line ${index}`)
    const bounded = boundArchiveLines(lines)
    expect(bounded.truncated).toBe(true)
    expect(totalCost(bounded.lines)).toBeLessThanOrEqual(TERMINAL_ARCHIVE_MAX_CHARS)
    expect(bounded.lines.at(-1)).toBe(lines.at(-1))
    expect(bounded.lines).toEqual(lines.slice(lines.length - bounded.lines.length))
  })

  it('truncates a single oversized line from its tail', () => {
    const bounded = boundArchiveLines(['x'.repeat(TERMINAL_ARCHIVE_MAX_CHARS * 2)])
    expect(bounded.truncated).toBe(true)
    expect(bounded.lines).toHaveLength(1)
    expect(bounded.lines[0]).toHaveLength(TERMINAL_ARCHIVE_MAX_CHARS - 1)
  })

  it('bounds a blank-line flood in linear time', () => {
    // The char budget admits ~262k blank lines; an unshift-per-line build was ~4.3s here.
    const startedAt = performance.now()
    const bounded = boundArchiveLines(Array.from({ length: 300_000 }, () => ''))
    expect(bounded.lines).toHaveLength(TERMINAL_ARCHIVE_MAX_CHARS)
    expect(performance.now() - startedAt).toBeLessThan(500)
  })
})
