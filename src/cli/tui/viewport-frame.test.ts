import { describe, expect, it } from 'vitest'
import { viewportRows } from './viewport-frame'
import { emptyAnsiFrame, type TerminalAnsiFrame } from './terminal-ansi-source'
import { cellWidth } from './text-width'

function ansiFrame(data: string): TerminalAnsiFrame {
  return { data, cols: 80, rows: 24, plainLines: [], connected: true, plainFallback: false }
}

describe('viewportRows', () => {
  it('returns exactly `height` rows of exactly `width` visible cells', () => {
    const rows = viewportRows(ansiFrame('one\ntwo\nthree'), 10, 5)
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(cellWidth(row)).toBe(10)
    }
  })

  it('keeps the newest lines at the bottom (bottom-N window)', () => {
    const rows = viewportRows(ansiFrame('l1\nl2\nl3\nl4'), 10, 2)
    expect(rows[0]).toContain('l3')
    expect(rows[1]).toContain('l4')
  })

  it('scrolls back through history with a scroll offset', () => {
    const frame = ansiFrame('l1\nl2\nl3\nl4\nl5')
    const live = viewportRows(frame, 10, 2, 0)
    expect(live[1]).toContain('l5')
    const back = viewportRows(frame, 10, 2, 2)
    expect(back[0]).toContain('l2')
    expect(back[1]).toContain('l3')
  })

  it('clips wide lines to the viewport width', () => {
    const rows = viewportRows(ansiFrame('abcdefghijklmnop'), 6, 1)
    expect(cellWidth(rows[0])).toBe(6)
  })

  it('shows a placeholder when there is no output', () => {
    const rows = viewportRows(emptyAnsiFrame(), 20, 3)
    expect(rows.join('')).toContain('connecting')
  })

  it('explains when the runtime lacks terminal.readAnsi', () => {
    const frame: TerminalAnsiFrame = {
      data: null,
      cols: 0,
      rows: 0,
      plainLines: [],
      connected: true,
      plainFallback: true,
      ansiUnsupported: true
    }
    const rows = viewportRows(frame, 50, 5)
    expect(rows.join('\n')).toContain('newer Orca runtime')
  })

  it('falls back to plain-text tail lines', () => {
    const frame: TerminalAnsiFrame = {
      data: null,
      cols: 0,
      rows: 0,
      plainLines: ['hello', 'world'],
      connected: true,
      plainFallback: true
    }
    const rows = viewportRows(frame, 10, 2)
    expect(rows[1]).toContain('world')
  })
})
