import { describe, expect, it } from 'vitest'
import { boundArchiveLines } from './worker-output-archive'

const TERMINAL_ARCHIVE_MAX_CHARS = 262_144

function totalCost(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

describe('boundArchiveLines', () => {
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
})
