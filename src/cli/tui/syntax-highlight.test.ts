import { describe, expect, it } from 'vitest'
import { highlightLine, languageFromPath } from './syntax-highlight'

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(SGR, '')

describe('languageFromPath', () => {
  it('returns the extension for code and "plain" for non-code', () => {
    expect(languageFromPath('src/a.ts')).toBe('ts')
    expect(languageFromPath('x.py')).toBe('py')
    expect(languageFromPath('notes.md')).toBe('plain')
    expect(languageFromPath('data.json')).toBe('plain')
    expect(languageFromPath(null)).toBe('plain')
  })
})

describe('highlightLine', () => {
  it('leaves plain text untouched', () => {
    expect(highlightLine('const x = 1', 'plain')).toBe('const x = 1')
  })

  it('colors a keyword but preserves the visible text', () => {
    const out = highlightLine('const x = 1', 'ts')
    expect(out).toContain('\x1b[')
    expect(strip(out)).toBe('const x = 1')
  })

  it('does not color a keyword that sits inside a string', () => {
    const out = highlightLine('const s = "return"', 'ts')
    // The string run is one green span; "return" inside it gets no keyword color.
    expect(out).toContain('\x1b[32m"return"\x1b[0m')
  })

  it('treats // as a comment for c-like and # for python', () => {
    expect(highlightLine('x // hi', 'ts')).toContain('\x1b[2m// hi')
    expect(highlightLine('x # hi', 'py')).toContain('\x1b[2m# hi')
    expect(highlightLine('x // hi', 'py')).not.toContain('\x1b[2m// hi')
  })
})
