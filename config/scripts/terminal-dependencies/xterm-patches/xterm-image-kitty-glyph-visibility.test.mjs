import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  placeholderCells,
  write
} from './xterm-kitty-placeholder-test-terminal.mjs'

const INVISIBLE = 0x40000000
const PLACEHOLDER = String.fromCodePoint(0x10eeee)
afterEach(() => vi.unstubAllGlobals())

const cell = (h, row = 0, col = 0) => h.terminal.buffer.active.getLine(row)?.getCell(col)

function reservedRow(h, last = false) {
  const buffer = h.terminal._core.buffer
  for (
    let index = last ? buffer.lines.length - 1 : 0;
    last ? index >= 0 : index < buffer.lines.length;
    index += last ? -1 : 1
  ) {
    if (buffer.lines.get(index).getString(0).codePointAt(0) === 0x10eeee) {
      return index
    }
  }
  throw new Error('Expected reserved text in the real buffer')
}

describe('reserved placeholder glyph visibility', () => {
  it('hides an unknown bare reserved character and retains its non-BMP codepoint', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, `${PLACEHOLDER}😀X`)
      expect(cell(h).isInvisible()).toBeTruthy()
      expect(cell(h).getChars()).toBe(PLACEHOLDER)
      expect(cell(h).getCode()).toBe(0x10eeee)
      expect(cell(h, 0, 1).getChars()).toBe('😀')
      expect(cell(h, 0, 1).getWidth()).toBe(2)
      expect(cell(h, 0, 1).isInvisible()).toBeFalsy()
      expect(cell(h, 0, 3).getChars()).toBe('X')
    } finally {
      h.terminal.dispose()
    }
  })

  it('ordinary text overwrites clear invisibility and remain visible', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, placeholderCells(7, 10))
      expect(cell(h).isInvisible()).toBeTruthy()
      await write(h.terminal, '\x1b[1;1HAB')
      expect(cell(h).getChars()).toBe('A')
      expect(cell(h, 0, 1).getChars()).toBe('B')
      expect(cell(h).isInvisible()).toBeFalsy()
      expect(cell(h, 0, 1).isInvisible()).toBeFalsy()
    } finally {
      h.terminal.dispose()
    }
  })

  it('masks offscreen cells synchronously when public scroll and resize reveal them', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, `${PLACEHOLDER}\r\n${'ROW\r\n'.repeat(24)}`)
      const buffer = h.terminal._core.buffer
      const first = reservedRow(h)
      expect(first).toBeLessThan(buffer.ybase)
      expect(buffer.lines.get(first).getFg(0) & INVISIBLE).toBe(0)
      h.terminal.scrollToTop()
      await Promise.resolve()
      expect(buffer.lines.get(first).getFg(0) & INVISIBLE).toBeTruthy()
      h.terminal.scrollToBottom()
      await write(h.terminal, `\x1b[H${PLACEHOLDER}\u030D\r\n${'ROW\r\n'.repeat(24)}`)
      const last = reservedRow(h, true)
      expect(last).toBeLessThan(buffer.ybase)
      expect(buffer.lines.get(last).getFg(0) & INVISIBLE).toBe(0)
      h.terminal.resize(20, 50)
      expect(buffer.lines.get(last).getFg(0) & INVISIBLE).toBeTruthy()
    } finally {
      h.terminal.dispose()
    }
  })

  it('addon disposal releases visibility subscriptions while keeping the terminal usable', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, PLACEHOLDER)
      expect(cell(h).isInvisible()).toBeTruthy()
      h.addon.dispose()
      await write(h.terminal, `\x1b[2J\x1b[H${PLACEHOLDER}`)
      expect(cell(h).getChars()).toBe(PLACEHOLDER)
      expect(cell(h).isInvisible()).toBeFalsy()
      h.terminal.resize(21, 7)
      expect(cell(h).isInvisible()).toBeFalsy()
    } finally {
      h.terminal.dispose()
    }
  })
})
