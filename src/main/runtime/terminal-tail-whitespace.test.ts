import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { trimTerminalLineRight } from './terminal-tail-line-controls'

describe('terminal redraw whitespace', () => {
  it.each([
    ['hello \t', 'hello'],
    [' \thello \t world \t', ' \thello \t world'],
    [' \t', ''],
    ['hello\u00a0 \t', 'hello\u00a0'],
    ['hello\n', 'hello\n']
  ])('preserves terminal text while trimming spaces and tabs: %j', (input, expected) => {
    expect(trimTerminalLineRight(input)).toBe(expected)
  })

  it.each([2, 20])('handles padded redraws across %i retained rows without stalling', (rows) => {
    const padded = `${' '.repeat(32_000)}marker \t`
    const previousLines = Array.from({ length: rows }, (_, index) =>
      index === 0 ? padded : `row ${index}`
    )
    const start = performance.now()
    let result: ReturnType<typeof appendNormalizedToTailBuffer> | undefined
    for (let frame = 0; frame < 4; frame += 1) {
      result = appendNormalizedToTailBuffer(previousLines, 'footer', '\x1b[1A\rupdated')
    }
    const elapsedMs = performance.now() - start
    expect(result?.lines[0]).toBe(`${' '.repeat(32_000)}marker`)
    // Interior padding made the trailing-whitespace regex backtrack quadratically.
    expect(elapsedMs).toBeLessThan(500)
  })
})
