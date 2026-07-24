import { describe, expect, it } from 'vitest'
import { appendRateLimitPtyOutputTail } from './rate-limit-pty-output-tail'

describe('appendRateLimitPtyOutputTail', () => {
  it('preserves ordinary output exactly', () => {
    const first = appendRateLimitPtyOutputTail('', 'first', 16)
    const second = appendRateLimitPtyOutputTail(first.output, ' second', 16)

    expect(second).toEqual({
      output: 'first second',
      scannedChunk: ' second'
    })
  })

  it('keeps the exact newest characters across chunks', () => {
    const first = appendRateLimitPtyOutputTail('', '123456', 8)
    const second = appendRateLimitPtyOutputTail(first.output, '789tail', 8)

    expect(second.output).toBe('6789tail')
  })

  it('copies only a bounded suffix from one oversized PTY chunk', () => {
    const result = appendRateLimitPtyOutputTail('old', `HEAD${'x'.repeat(1_000_000)}TAIL`, 16)

    expect(result.output).toHaveLength(16)
    expect(result.output).toBe(result.scannedChunk)
    expect(result.output).toBe(`${'x'.repeat(12)}TAIL`)
    expect(result.output).not.toContain('HEAD')
  })

  it('preserves UTF-16 code units at the retained boundary', () => {
    const result = appendRateLimitPtyOutputTail('', `${'x'.repeat(20)}😀`, 2)

    expect(result.output).toBe('😀')
  })
})
