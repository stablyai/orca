import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  placeholderCells,
  TrackedBitmap,
  write
} from './xterm-kitty-placeholder-test-terminal.mjs'

const INVISIBLE = 0x40000000
const PLACEHOLDER = String.fromCodePoint(0x10eeee)
afterEach(() => vi.unstubAllGlobals())

const cell = (h, row = 0, col = 0) => h.terminal.buffer.active.getLine(row)?.getCell(col)

function metadata(line, col) {
  return {
    words: [...line._data.subarray(col * 3, col * 3 + 3)],
    chars: line.getString(col),
    width: line.getWidth(col),
    code: line.getCodePoint(col),
    combined: line.isCombined(col),
    extended: line._extendedAttrs[col]
  }
}

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

  it('masks a reserved cell without replacing its physical tile payload or linked attributes', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(
        h.terminal,
        `\x1b[4;48;2;30;40;50m\x1b]8;;https://example.invalid/\x1b\\${placeholderCells(7, 10, 1, 1)}\x1b]8;;\x1b\\\x1b[H`
      )
      const bitmap = new TrackedBitmap(10, 10)
      h.storage.addImage(bitmap, { scrolling: true, layer: 'top', zIndex: 0, cursorPos: 'iip' })
      const line = h.terminal._core.buffer.lines.get(0)
      const realCell = cell(h)
      realCell.fg &= ~INVISIBLE
      line.setCell(0, realCell)
      const before = metadata(line, 0)
      const extended = line.getExtended(0)
      const payload = extended.payload
      const attrs = [extended.ext, extended.urlId, extended.underlineColor]
      expect(extended.urlId).toBeGreaterThan(0)
      expect(extended.underlineColor & 0xffffff).toBe(10)
      expect(h.storage._images.get(payload.imageId).orig).toBe(bitmap)
      h.kitty.hidePlaceholderGlyphs(h.terminal)
      const after = metadata(line, 0)
      expect(after).toEqual({
        ...before,
        words: [before.words[0], before.words[1] | INVISIBLE, before.words[2]]
      })
      expect(line.getExtended(0)).toBe(extended)
      expect(line.getExtended(0).payload).toBe(payload)
      expect([extended.ext, extended.urlId, extended.underlineColor]).toEqual(attrs)
      const drawImage = vi.fn()
      const canvas = { getContext: () => ({ drawImage }) }
      window.document = { createElement: () => canvas }
      expect(h.storage.getImageAtBufferCell(0, 0)).toBe(canvas)
      expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 10, 10)
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

  it('cancels a queued scroll scan when the addon is disposed', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, `${PLACEHOLDER}\r\n${'ROW\r\n'.repeat(24)}`)
      const scans = vi.spyOn(h.kitty, 'hidePlaceholderGlyphs')
      h.terminal.scrollToTop()
      h.addon.dispose()
      await Promise.resolve()
      expect(scans).not.toHaveBeenCalled()
      expect(cell(h).getChars()).toBe(PLACEHOLDER)
      expect(cell(h).isInvisible()).toBeFalsy()
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
