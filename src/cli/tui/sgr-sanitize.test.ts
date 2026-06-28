import { describe, expect, it } from 'vitest'
import { sanitizeToSgr } from './sgr-sanitize'

const ESC = '\x1b'

describe('sanitizeToSgr', () => {
  it('keeps SGR color/formatting runs verbatim', () => {
    const line = `${ESC}[38;2;255;0;0m${ESC}[1mRED${ESC}[0m`
    expect(sanitizeToSgr(line)).toBe(line)
  })

  it('expands a cursor-forward skip into spaces (preserves columns)', () => {
    expect(sanitizeToSgr(`a${ESC}[5Cb`)).toBe('a     b')
    expect(sanitizeToSgr(`a${ESC}[Cb`)).toBe('a b')
  })

  it('drops private-mode sets, cursor-home, and other cursor moves', () => {
    expect(sanitizeToSgr(`${ESC}[?1049h${ESC}[H${ESC}[2Jhello${ESC}[3Aworld`)).toBe('helloworld')
  })

  it('drops OSC strings (titles / hyperlinks)', () => {
    expect(sanitizeToSgr(`${ESC}]0;my title${ESC}\\text`)).toBe('text')
    expect(sanitizeToSgr(`${ESC}]8;;https://x${'\x07'}link${ESC}]8;;${'\x07'}`)).toBe('link')
  })

  it('leaves plain text untouched', () => {
    expect(sanitizeToSgr('just plain text')).toBe('just plain text')
  })
})
