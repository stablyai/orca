import { describe, expect, it } from 'vitest'
import { herdrLogicalKeyForBytes } from './herdr-logical-key'

describe('herdrLogicalKeyForBytes', () => {
  it.each([
    ['\x03', 'ctrl+c'],
    ['\x04', 'ctrl+d'],
    ['\x1a', 'ctrl+z'],
    ['\x1c', 'ctrl+\\'],
    ['\x0c', 'ctrl+l'],
    ['\t', 'tab'],
    ['\r', 'enter'],
    ['\x7f', 'backspace'],
    ['\x08', 'backspace'],
    ['\x1b', 'esc']
  ] as const)('maps %j to %s', (bytes, key) => {
    expect(herdrLogicalKeyForBytes(bytes)).toBe(key)
  })

  it('maps kitty functional singles to the same Herdr names', () => {
    expect(herdrLogicalKeyForBytes('\x1b[27u')).toBe('esc')
    expect(herdrLogicalKeyForBytes('\x1b[27;1u')).toBe('esc')
    expect(herdrLogicalKeyForBytes('\x1b[9u')).toBe('tab')
    expect(herdrLogicalKeyForBytes('\x1b[13u')).toBe('enter')
    expect(herdrLogicalKeyForBytes('\x1b[127u')).toBe('backspace')
    expect(herdrLogicalKeyForBytes('\x1b[99;5u')).toBe('ctrl+c')
    expect(herdrLogicalKeyForBytes('\x1b[100;5u')).toBe('ctrl+d')
  })

  it('does not map sequences that must stay on the text path', () => {
    expect(herdrLogicalKeyForBytes('\x1b\x7f')).toBeNull()
    expect(herdrLogicalKeyForBytes('\x1b[A')).toBeNull()
    expect(herdrLogicalKeyForBytes('a')).toBeNull()
    expect(herdrLogicalKeyForBytes('hello')).toBeNull()
    expect(herdrLogicalKeyForBytes('\x1b[27;1;3u')).toBeNull()
  })
})
