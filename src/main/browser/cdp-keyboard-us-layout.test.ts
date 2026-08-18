import { describe, it, expect } from 'vitest'
import { imeFallbackKeyEvent, parseCdpKeyEvent } from './cdp-keyboard-us-layout'

describe('parseCdpKeyEvent', () => {
  it('maps every printable ASCII character to a key event that types that character', () => {
    const broken: string[] = []
    for (let charCode = 32; charCode <= 126; charCode++) {
      const ch = String.fromCharCode(charCode)
      const parsed = parseCdpKeyEvent(ch)
      if (!parsed || parsed.text !== ch || parsed.keyCode === 0) {
        broken.push(ch)
      }
    }
    expect(broken).toEqual([])
  })

  it.each([
    ['#', 51],
    ['$', 52],
    ['%', 53],
    ['&', 55],
    ["'", 222],
    ['(', 57],
    ['.', 190]
  ])(
    'gives %s the US-layout key code %i instead of its own char code',
    (ch: string, keyCode: number) => {
      // Why: charCodeAt-derived codes put '&' on VK_UP (38) and '.' on VK_DELETE (46),
      // which Blink executes as caret commands that swallow the character.
      expect(parseCdpKeyEvent(ch)).toMatchObject({ keyCode, text: ch })
    }
  )

  it.each([
    ['Ctrl+A', { keyCode: 65, key: 'a', modifiers: 2, text: null }],
    ['Control+a', { keyCode: 65, key: 'a', modifiers: 2, text: null }],
    ['Shift+Home', { keyCode: 36, key: 'Home', modifiers: 8, text: null }],
    ['Alt+ArrowDown', { keyCode: 40, key: 'ArrowDown', modifiers: 1, text: null }],
    ['Ctrl+Shift+K', { keyCode: 75, key: 'K', modifiers: 10, text: null }],
    ['Meta+r', { keyCode: 82, key: 'r', modifiers: 4, text: null }],
    ['Control+Shift+r', { keyCode: 82, key: 'R', modifiers: 10, text: null }]
  ])('parses the shortcut %s', (raw: string, expected: object) => {
    expect(parseCdpKeyEvent(raw)).toMatchObject(expected)
  })

  it('treats a capital letter in a shortcut as the key name, not a shift request', () => {
    expect(parseCdpKeyEvent('Ctrl+A')).toMatchObject({ key: 'a', modifiers: 2 })
    expect(parseCdpKeyEvent('Ctrl+Shift+A')).toMatchObject({ key: 'A', modifiers: 10 })
  })

  it('shifts a bare capital letter and reports the shifted character as text', () => {
    expect(parseCdpKeyEvent('R')).toMatchObject({ keyCode: 82, key: 'R', modifiers: 8, text: 'R' })
    expect(parseCdpKeyEvent('Shift+a')).toMatchObject({ key: 'A', modifiers: 8, text: 'A' })
  })

  it('maps shifted punctuation onto its base key with shift held', () => {
    expect(parseCdpKeyEvent('Shift+1')).toMatchObject({ keyCode: 49, key: '!', text: '!' })
    expect(parseCdpKeyEvent('+')).toMatchObject({ keyCode: 187, modifiers: 8, text: '+' })
  })

  it.each([
    ['Enter', { keyCode: 13, text: '\r' }],
    ['Space', { keyCode: 32, key: ' ', text: ' ' }],
    ['Esc', { keyCode: 27, key: 'Escape', text: null }],
    ['PgDn', { keyCode: 34, key: 'PageDown', text: null }],
    ['ContextMenu', { keyCode: 93, text: null }],
    ['F5', { keyCode: 116, key: 'F5', code: 'F5', text: null }],
    ['F12', { keyCode: 123, text: null }]
  ])('parses the named key %s', (raw: string, expected: object) => {
    expect(parseCdpKeyEvent(raw)).toMatchObject(expected)
  })

  it.each([['MediaPlayPause'], ['F25'], [''], ['NoSuchKey']])(
    'returns null for %s so the caller can fall back',
    (raw: string) => {
      expect(parseCdpKeyEvent(raw)).toBeNull()
    }
  )
})

describe('imeFallbackKeyEvent', () => {
  it.each([['é'], ['ß'], ['ñ'], ['ü'], ['漢'], ['한']])(
    'gives %s the IME key event form with keyCode 229 and its text',
    (ch: string) => {
      expect(imeFallbackKeyEvent(ch)).toEqual({
        keyCode: 229,
        key: ch,
        code: '',
        modifiers: 0,
        text: ch
      })
    }
  )

  it.each([
    ['a table-covered ASCII character', 'a'],
    ['a surrogate-pair emoji', '👍'],
    ['a combining sequence', 'e\u0301'],
    ['a multi-character name', 'MediaPlayPause'],
    ['a chord with a non-US character', 'Ctrl+é'],
    ['an empty string', '']
  ])('returns null for %s so the helper keeps its behavior', (_name: string, raw: string) => {
    expect(imeFallbackKeyEvent(raw)).toBeNull()
  })
})
