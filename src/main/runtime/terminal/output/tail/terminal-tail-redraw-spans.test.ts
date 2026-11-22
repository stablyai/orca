import { describe, expect, it } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'

describe('retained terminal redraw text spans', () => {
  it('keeps completed trailing spaces available to a later cursor-up rewrite', () => {
    const result = appendNormalizedToTailBuffer(['abcdef'], '', '\x1b[1A\rab   \n\x1b[1A\x1b[5GX\n')
    expect(result.lines).toEqual(['ab  Xf'])
    expect(result.newlyCompletedLines).toEqual(['ab   f', 'ab  Xf'])
  })
})
