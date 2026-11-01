import { describe, expect, it } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'

describe('retained terminal redraw text spans', () => {
  it.each([
    ['shorter overwrite', '\x1b[1A\rXY\n', 'XYcdef'],
    ['extending overwrite', '\x1b[1A\r123456789\n', '123456789'],
    ['erase to end', '\x1b[1A\rXY\x1b[KZ\n', 'XYZ'],
    ['erase to start', '\x1b[1A\rXY\x1b[2C!\x1b[1KZ\n', '     Z'],
    ['erase whole line', '\x1b[1A\rXY\x1b[2KZ\n', '  Z'],
    ['backspace', '\x1b[1A\rXY\bZ\n', 'XZcdef'],
    ['carriage return', '\x1b[1A\rXY\rZ\n', 'ZYcdef'],
    ['split surrogate overwrite', '\x1b[1A\r😀\bZ\n', '\ud83dZcdef'],
    [
      'Unicode and non-special controls',
      '\x1b[1A\r漢😀e\u0301\ud800\t\u0000\udfff\bZ\n',
      '漢😀e\u0301\ud800\t\u0000Z'
    ]
  ])('preserves %s', (_name, chunk, expected) => {
    const result = appendNormalizedToTailBuffer(['abcdef'], '', chunk)
    expect(result).toEqual({
      lines: [expected],
      partialLine: '',
      redrawCursor: null,
      truncated: false,
      newCompleteLines: 1,
      newlyCompletedLines: [expected]
    })
  })

  it('fills a cursor gap before a text span and retains its code-unit column', () => {
    const result = appendNormalizedToTailBuffer(['abcdef'], '', '\x1b[1A\x1b[9G😀')
    expect(result.lines).toEqual([])
    expect(result.partialLine).toBe('abcdef  😀')
    expect(result.redrawCursor).toBeNull()
  })

  it('keeps completed trailing spaces available to a later cursor-up rewrite', () => {
    const result = appendNormalizedToTailBuffer(['abcdef'], '', '\x1b[1A\rab   \n\x1b[1A\x1b[5GX\n')
    expect(result.lines).toEqual(['ab  Xf'])
    expect(result.newlyCompletedLines).toEqual(['ab   f', 'ab  Xf'])
  })
})
