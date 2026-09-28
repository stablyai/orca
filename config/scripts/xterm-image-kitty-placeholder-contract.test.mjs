import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { ImageAddon } = require('@xterm/addon-image')

// 1x1 PNG; every decoded bitmap in these cases is stubbed, so only the
// transmission path is exercised.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

class TrackedBitmap {
  constructor(width = 20, height = 10) {
    this.width = width
    this.height = height
    this.close = vi.fn()
  }
}

const PLACEHOLDER = '\u{10EEEE}'
// Diacritics 0 and 1 of kitty's row/column table: rows first, then columns.
const ROW_0 = '\u0305'
const ROW_1 = '\u030D'
const COLUMN_0 = '\u0305'
const COLUMN_1 = '\u030D'
const CELL = { width: 10, height: 10 }

function createTerminal() {
  const bitmap = new TrackedBitmap()
  const createImageBitmap = () => Promise.resolve(bitmap)
  vi.stubGlobal('ImageBitmap', TrackedBitmap)
  vi.stubGlobal('createImageBitmap', createImageBitmap)
  // The handler decodes through `window.createImageBitmap`; without it the PNG
  // path falls back to object URLs, which node lacks.
  vi.stubGlobal('window', { ImageBitmap: TrackedBitmap, createImageBitmap })
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 6 })
  const addon = new ImageAddon({
    enableSizeReports: false,
    storageLimit: 32,
    kittySizeLimit: 8 * 1024 * 1024
  })
  terminal.loadAddon(addon)
  const renderer = addon._renderer
  vi.spyOn(renderer, 'cellSize', 'get').mockReturnValue({ ...CELL })
  const drawImage = vi.fn()
  renderer._layers.set('top', { drawImage, clearRect() {}, canvas: { remove() {} } })
  return {
    terminal,
    addon,
    renderer,
    bitmap,
    drawImage,
    storage: addon._storage,
    kitty: addon._handlers.get('kitty')
  }
}

function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function writeKitty(terminal, command, payload) {
  return write(terminal, `\x1b_G${command};${payload}\x1b\\`)
}

/** Placeholder cells for a 2x2 grid, colored with the image id. */
function placeholders(imageId) {
  return (
    `\x1b[38;5;${imageId}m` +
    `${PLACEHOLDER}${ROW_0}${COLUMN_0}${PLACEHOLDER}${ROW_0}${COLUMN_1}` +
    `\r\n` +
    `${PLACEHOLDER}${ROW_1}${COLUMN_0}${PLACEHOLDER}${ROW_1}${COLUMN_1}` +
    `\x1b[39m`
  )
}

/** Destination rectangle of a drawImage call, which is where a tile lands. */
function destination(call) {
  return [call[5], call[6], call[7], call[8]]
}

afterEach(() => vi.unstubAllGlobals())

describe('xterm image kitty unicode placeholder contract', () => {
  it('paints virtual placement tiles into the placeholder cells', async () => {
    const { terminal, bitmap, drawImage, storage, kitty } = createTerminal()
    try {
      await writeKitty(terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      expect(kitty._kittyStorage.images.size).toBe(1)
      // A virtual placement must not paint anything at the cursor itself.
      storage.render({ start: 0, end: 5 })
      expect(drawImage).not.toHaveBeenCalled()

      await write(terminal, placeholders(7))
      storage.render({ start: 0, end: 5 })

      // One run per row: both cells of a row are one draw, addressed from the
      // image's 2x2 grid, and row 1 lands one cell lower.
      expect(drawImage).toHaveBeenCalledTimes(2)
      const [firstRow, secondRow] = drawImage.mock.calls
      expect(firstRow[0]).toBe(bitmap)
      expect(destination(firstRow)).toEqual([0, 5, 20, 5])
      expect(destination(secondRow)).toEqual([0, 10, 20, 5])
      // The 20x10 image is letterboxed into the 20x20 cell box, so the top row
      // of cells shows its first 5 pixel rows and the second row the next 5.
      expect(firstRow.slice(1, 5)).toEqual([0, 0, 20, 5])
      expect(secondRow.slice(1, 5)).toEqual([0, 5, 20, 5])
    } finally {
      terminal.dispose()
    }
  })

  it('still paints a plain placement at the cursor', async () => {
    const { terminal, bitmap, drawImage, storage } = createTerminal()
    try {
      await writeKitty(terminal, 'a=T,f=100,i=7', PNG)
      await write(terminal, placeholders(7))
      storage.render({ start: 0, end: 5 })

      // No virtual placement was created, so the U+10EEEE cells are only text.
      expect(drawImage).toHaveBeenCalledTimes(1)
      expect(drawImage.mock.calls[0][0]).toBe(bitmap)
      expect(destination(drawImage.mock.calls[0])).toEqual([0, 0, 20, 10])
    } finally {
      terminal.dispose()
    }
  })

  it('stops painting placeholders once the image is deleted', async () => {
    const { terminal, drawImage, storage } = createTerminal()
    try {
      await writeKitty(terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(terminal, placeholders(7))
      storage.render({ start: 0, end: 5 })
      expect(drawImage).toHaveBeenCalledTimes(2)
      drawImage.mockClear()

      await writeKitty(terminal, 'a=d,d=i,i=7,q=2', '')
      storage.render({ start: 0, end: 5 })
      expect(drawImage).not.toHaveBeenCalled()
    } finally {
      terminal.dispose()
    }
  })

  it('paints nothing for a placeholder whose image id is unknown', async () => {
    const { terminal, drawImage, storage } = createTerminal()
    try {
      await writeKitty(terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(terminal, placeholders(200))
      storage.render({ start: 0, end: 5 })
      expect(drawImage).not.toHaveBeenCalled()
    } finally {
      terminal.dispose()
    }
  })
})
