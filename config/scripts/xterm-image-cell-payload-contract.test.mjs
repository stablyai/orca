import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { ImageAddon } = require('@xterm/addon-image')

function createTerminal(cols = 6) {
  vi.stubGlobal('window', {})
  const terminal = new Terminal({ cols, rows: 4, scrollback: 20, allowProposedApi: true })
  const addon = new ImageAddon({ enableSizeReports: false, storageLimit: 32 })
  terminal.loadAddon(addon)
  vi.spyOn(addon._renderer, 'cellSize', 'get').mockReturnValue({ width: 7, height: 14 })
  return { terminal, storage: addon._storage }
}

function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function place(storage, cols = 1) {
  const image = { width: cols * 7, height: 14 }
  const id = storage.addImage(image, {
    scrolling: true,
    layer: 'top',
    zIndex: 0,
    cursorPos: 'iip'
  })
  return { image, id }
}

function line(terminal, row = 0) {
  return terminal._core.buffer.lines.get(row)
}

function cells(terminal) {
  const result = []
  for (let row = 0; row < terminal._core.buffer.lines.length; row++) {
    for (let col = 0; col < terminal.cols; col++) {
      const payload = line(terminal, row).getExtended(col).payload
      if (payload !== undefined) {
        result.push({ row, col, payload })
      }
    }
  }
  return result
}

afterEach(() => vi.unstubAllGlobals())

describe('installed xterm image cell payload contract', () => {
  it('isolates image tiles from shared hyperlink attributes and unrelated payloads', async () => {
    const { terminal, storage } = createTerminal()
    try {
      await write(terminal, '\x1b[1;31;44m\x1b]8;id=shared;https://example.test\x1b\\ABC')
      const bufferLine = line(terminal)
      const shared = bufferLine.getExtended(1)
      expect(bufferLine.getExtended(2)).toBe(shared)
      const before = [1, 2].map((col) => ({
        text: terminal.buffer.active.getLine(0).getCell(col).getChars(),
        width: terminal.buffer.active.getLine(0).getCell(col).getWidth(),
        fg: bufferLine.getFg(col),
        bg: bufferLine.getBg(col)
      }))
      const unrelated = { kind: 'other-addon' }
      const cell = terminal.buffer.active.getLine(0).getCell(0)
      cell.extended = cell.extended.clone()
      cell.extended.payload = unrelated
      cell.updateExtended()
      bufferLine.setCell(0, cell)
      await write(terminal, '\x1b[1;2H')
      const placed = place(storage, 2)
      for (const [index, col] of [1, 2].entries()) {
        const current = terminal.buffer.active.getLine(0).getCell(col)
        expect(current.getChars()).toBe(before[index].text)
        expect(current.getWidth()).toBe(before[index].width)
        expect(bufferLine.getFg(col)).toBe(before[index].fg)
        expect(bufferLine.getBg(col)).toBe(before[index].bg)
        expect(bufferLine.getExtended(col).urlId).toBe(shared.urlId)
        expect(bufferLine.getExtended(col).payload).toMatchObject({
          imageId: placed.id,
          tileId: index
        })
        expect(storage.getImageAtBufferCell(col, 0)).toBe(placed.image)
      }
      expect(bufferLine.getExtended(1)).not.toBe(bufferLine.getExtended(2))
      expect(shared.payload).toBeUndefined()
      expect(bufferLine.getExtended(0).payload).toBe(unrelated)
      expect(bufferLine.getExtended(0).isEmpty()).toBe(false)
      expect(storage.getImageAtBufferCell(0, 0)).toBeUndefined()
      await write(terminal, '\x1b[1;2H')
      const replacement = place(storage)
      expect(storage.getImageAtBufferCell(1, 0)).toBe(replacement.image)
      expect(storage.getImageAtBufferCell(2, 0)).toBe(placed.image)
      expect(bufferLine.getExtended(2).payload).toMatchObject({ imageId: placed.id, tileId: 1 })
    } finally {
      terminal.dispose()
    }
  })

  it('retains wide and combining text when physical tiles are attached', async () => {
    const { terminal, storage } = createTerminal()
    try {
      await write(terminal, 'A界e\u0301😀\x1b[1;2H')
      const placed = place(storage, 3)
      const publicLine = terminal.buffer.active.getLine(0)
      expect(publicLine.getCell(1).getChars()).toBe('界')
      expect(publicLine.getCell(1).getWidth()).toBe(2)
      expect(publicLine.getCell(2).getWidth()).toBe(0)
      expect(publicLine.getCell(3).getChars()).toBe('e\u0301')
      expect(publicLine.getCell(3).getWidth()).toBe(1)
      expect(publicLine.getCell(4).getChars()).toBe('😀')
      for (let col = 1; col <= 3; col++) {
        expect(storage.getImageAtBufferCell(col, 0)).toBe(placed.image)
      }
      expect(cells(terminal)).toHaveLength(3)
    } finally {
      terminal.dispose()
    }
  })

  it('moves tiles through insert/delete without leaking reused cell attributes', async () => {
    const { terminal, storage } = createTerminal()
    try {
      await write(terminal, 'ABC\x1b[1;2H')
      const placed = place(storage)
      await write(terminal, '\x1b[1;1H\x1b[@')
      expect(storage.getImageAtBufferCell(2, 0)).toBe(placed.image)
      expect(line(terminal).getExtended(0).payload).toBeUndefined()
      expect(line(terminal).getExtended(1).payload).toBeUndefined()
      await write(terminal, '\x1b[P')
      expect(storage.getImageAtBufferCell(1, 0)).toBe(placed.image)
      expect(cells(terminal)).toHaveLength(1)
      await write(terminal, '\x1b[1;2H\x1b[0mX\x1b[2;1Hordinary')
      expect(terminal.buffer.active.getLine(0).getCell(1).getChars()).toBe('X')
      // Precondition: the stale map entry survives, so the next line proves the flag gates it.
      expect(line(terminal)._extendedAttrs[1].payload.imageId).toBe(placed.id)
      expect(line(terminal).getExtended(1).payload).toBeUndefined()
      expect(storage.getImageAtBufferCell(1, 0)).toBeUndefined()
      expect(cells(terminal)).toEqual([])
    } finally {
      terminal.dispose()
    }
  })

  it('preserves tile identity and source lookup across shrink and growth reflow', async () => {
    const { terminal, storage } = createTerminal(4)
    try {
      await write(terminal, 'ABCDEF\x1b[1;3H')
      const placed = place(storage, 2)
      await write(terminal, '\x1b[3;1H')
      terminal.resize(3, 4)
      expect(
        cells(terminal).map(({ row, col, payload }) => [row, col, payload.imageId, payload.tileId])
      ).toEqual([
        [0, 2, placed.id, 0],
        [1, 0, placed.id, 1]
      ])
      expect(storage.getImageAtBufferCell(2, 0)).toBe(placed.image)
      expect(storage.getImageAtBufferCell(0, 1)).toBe(placed.image)
      terminal.resize(4, 4)
      expect(
        cells(terminal).map(({ row, col, payload }) => [row, col, payload.imageId, payload.tileId])
      ).toEqual([
        [0, 2, placed.id, 0],
        [0, 3, placed.id, 1]
      ])
      expect(terminal.buffer.active.getLine(0).translateToString(true)).toBe('ABCD')
      expect(terminal.buffer.active.getLine(1).translateToString(true)).toBe('EF')
    } finally {
      terminal.dispose()
    }
  })

  it('isolates alternate-screen payloads and restores the normal image', async () => {
    const { terminal, storage } = createTerminal()
    try {
      const normal = place(storage)
      await write(terminal, '\x1b[?1049h\x1b[H')
      expect(cells(terminal)).toEqual([])
      const alternate = place(storage)
      expect(storage.getImageAtBufferCell(0, 0)).toBe(alternate.image)
      await write(terminal, '\x1b[?1049l')
      expect(storage.getImageAtBufferCell(0, 0)).toBe(normal.image)
      expect(cells(terminal)).toHaveLength(1)
      expect(cells(terminal)[0].payload.imageId).toBe(normal.id)
      await write(terminal, '\x1b[?1049h')
      expect(cells(terminal)).toEqual([])
      expect(storage.getImageAtBufferCell(0, 0)).toBeUndefined()
    } finally {
      terminal.dispose()
    }
  })

  it('replaces a foreign payload with a fresh tile without mutating it', async () => {
    const { terminal, storage } = createTerminal()
    try {
      await write(terminal, '\x1b]8;;https://example.test\x1b\\AB')
      const bufferLine = line(terminal)
      const foreign = { kind: 'other-addon' }
      const cell = terminal.buffer.active.getLine(0).getCell(0)
      cell.extended = cell.extended.clone()
      cell.extended.payload = foreign
      cell.updateExtended()
      bufferLine.setCell(0, cell)
      const foreignAttrs = bufferLine.getExtended(0)
      await write(terminal, '\x1b[1;1H')
      const placed = place(storage)
      expect(foreign).toEqual({ kind: 'other-addon' })
      expect(foreignAttrs.payload).toBe(foreign)
      expect(bufferLine.getExtended(0)).not.toBe(foreignAttrs)
      expect(bufferLine.getExtended(0).urlId).toBe(foreignAttrs.urlId)
      expect(bufferLine.getExtended(0).payload).toMatchObject({ imageId: placed.id, tileId: 0 })
      expect(storage.getImageAtBufferCell(0, 0)).toBe(placed.image)
    } finally {
      terminal.dispose()
    }
  })

  it('never reports a payload for plain cells, even after a caller writes the shared blank', async () => {
    const { terminal } = createTerminal()
    try {
      await write(terminal, 'AB')
      const bufferLine = line(terminal)
      // Plain cells share one scratch ExtendedAttrs; a stray write must not reach the next read.
      bufferLine.getExtended(0).payload = { kind: 'stray' }
      expect(bufferLine.getExtended(1).payload).toBeUndefined()
      expect(terminal.buffer.active.getLine(0).getCell(1).extended.payload).toBeUndefined()
    } finally {
      terminal.dispose()
    }
  })
})
