import { createRequire } from 'node:module'
import { vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { Unicode11Addon } = require('@xterm/addon-unicode11')
const { ImageAddon } = require(process.env.ORCA_IMAGE_CONTRACT_ADDON_PATH ?? '@xterm/addon-image')

export const PLACEHOLDER = '\u{10EEEE}'
export const DIACRITICS = ['\u0305', '\u030D', '\u030E']
DIACRITICS[128] = '\u082D'
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

export class TrackedBitmap {
  constructor(width = 20, height = 10) {
    this.width = width
    this.height = height
    this.close = vi.fn()
  }
}

export function createPlaceholderTerminal() {
  const bitmaps = []
  const decode = vi.fn(async () => {
    const bitmap = new TrackedBitmap()
    bitmaps.push(bitmap)
    return bitmap
  })
  vi.stubGlobal('ImageBitmap', TrackedBitmap)
  vi.stubGlobal('createImageBitmap', decode)
  vi.stubGlobal('window', { ImageBitmap: TrackedBitmap, createImageBitmap: decode })
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 6 })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  const addon = new ImageAddon({
    enableSizeReports: false,
    storageLimit: 32,
    kittySizeLimit: 8 * 1024 * 1024
  })
  terminal.loadAddon(addon)
  const renderer = addon._renderer
  vi.spyOn(renderer, 'cellSize', 'get').mockReturnValue({ width: 10, height: 10 })
  const drawImage = vi.fn()
  renderer._layers.set('top', { drawImage, clearRect() {}, canvas: { remove() {} } })
  return {
    terminal,
    addon,
    renderer,
    bitmaps,
    decode,
    drawImage,
    storage: addon._storage,
    kitty: addon._handlers.get('kitty')._kittyStorage
  }
}

export function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve))
}

export function writeKitty(terminal, command, payload = '') {
  return write(terminal, `\x1b_G${command};${payload}\x1b\\`)
}

export function placeholderCells(imageId, placementId = 0, cols = 2, rows = 2) {
  const id = imageId & 0xffffff
  const high = imageId >>> 24
  const colors =
    `\x1b[38;2;${id >>> 16};${(id >>> 8) & 255};${id & 255}m` +
    `\x1b[58;2;${placementId >>> 16};${(placementId >>> 8) & 255};${placementId & 255}m`
  return `${
    colors +
    Array.from({ length: rows }, (_, row) =>
      Array.from(
        { length: cols },
        (_, col) =>
          `${PLACEHOLDER}${DIACRITICS[row]}${DIACRITICS[col]}${high ? DIACRITICS[high] : ''}`
      ).join('')
    ).join('\r\n')
  }\x1b[0m`
}

export function render(harness) {
  harness.drawImage.mockClear()
  harness.storage.render({ start: 0, end: 5 })
  return harness.drawImage.mock.calls
}
