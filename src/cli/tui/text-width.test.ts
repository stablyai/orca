import { describe, expect, it } from 'vitest'
import { cellWidth, clipAnsi, fitCells, padCells, sliceCellsFrom } from './text-width'

const ESC = '\x1b'
const RED = `${ESC}[31m`
const RESET = `${ESC}[0m`

describe('sliceCellsFrom', () => {
  it('returns the tail after N visible cells', () => {
    expect(sliceCellsFrom('abcdef', 2)).toBe('cdef')
  })

  it('re-emits the active style at the cut so the tail stays styled', () => {
    // "ab" then red "cdef"; cut at 4 → inside the red run → tail keeps red.
    const line = `ab${RED}cdef${RESET}`
    const tail = sliceCellsFrom(line, 4)
    expect(tail.startsWith(RED)).toBe(true)
    expect(clipAnsi(tail, 10).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')).toBe('ef')
  })

  it('clip + slice partition a styled row losslessly in visible cells', () => {
    const line = `${RED}hello world${RESET}`
    const left = clipAnsi(line, 5)
    const right = sliceCellsFrom(line, 5)
    const strip = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
    expect(strip(left) + strip(right)).toBe('hello world')
  })
})

describe('cellWidth', () => {
  it('ignores ANSI escapes', () => {
    expect(cellWidth(`${RED}hello${RESET}`)).toBe(5)
  })

  it('counts wide (CJK) glyphs as two cells', () => {
    expect(cellWidth('日本')).toBe(4)
  })
})

describe('clipAnsi', () => {
  it('truncates by visible width, not byte length', () => {
    expect(cellWidth(clipAnsi(`${RED}hello world${RESET}`, 5))).toBe(5)
  })

  it('re-closes an open SGR run at the cut', () => {
    const clipped = clipAnsi(`${RED}hello world`, 3)
    expect(clipped.startsWith(RED)).toBe(true)
    expect(clipped.endsWith(RESET)).toBe(true)
    expect(cellWidth(clipped)).toBe(3)
  })

  it('does not split a wide glyph across the boundary', () => {
    // Width 3 can't fit the second wide glyph (would need 4); stops at 2.
    expect(cellWidth(clipAnsi('日本', 3))).toBe(2)
  })

  it('preserves truecolor + formatting SGR runs verbatim (full color support)', () => {
    const truecolor = `${ESC}[38;2;255;128;0m${ESC}[1mWARN${ESC}[0m ok`
    const clipped = clipAnsi(truecolor, 10)
    // The 24-bit foreground and bold introducers survive the slice untouched.
    expect(clipped).toContain(`${ESC}[38;2;255;128;0m`)
    expect(clipped).toContain(`${ESC}[1m`)
    expect(cellWidth(clipped)).toBe(7)
  })
})

describe('fitCells', () => {
  it('pads short text to exact width', () => {
    expect(fitCells('hi', 5)).toBe('hi   ')
  })

  it('truncates long text to exact width', () => {
    expect(cellWidth(fitCells('hello world', 5))).toBe(5)
  })
})

describe('padCells', () => {
  it('fills a styled line to width without counting escapes', () => {
    const padded = padCells(`${RED}ab${RESET}`, 5)
    expect(cellWidth(padded)).toBe(5)
  })
})
