import { createRequire } from 'node:module'
import { vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require(process.env.ORCA_IMAGE_CACHE_CORE ?? '@xterm/xterm')
const { ImageAddon } = require(process.env.ORCA_IMAGE_CACHE_ADDON ?? '@xterm/addon-image')

export class TrackedBitmap {
  width = 10
  height = 10
  close = vi.fn()
}

export function createTerminal(options = {}) {
  vi.stubGlobal('ImageBitmap', TrackedBitmap)
  vi.stubGlobal('window', { ImageBitmap: TrackedBitmap })
  const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 6, ...options })
  const addon = new ImageAddon({
    enableSizeReports: false,
    showPlaceholder: false,
    storageLimit: 32,
    kittySizeLimit: 8 * 1024 * 1024
  })
  terminal.loadAddon(addon)
  vi.spyOn(addon._renderer, 'cellSize', 'get').mockReturnValue({ width: 10, height: 10 })
  const drawImage = vi.fn()
  addon._renderer._layers.set('top', { drawImage, clearRect() {}, canvas: { remove() {} } })
  return {
    terminal,
    addon,
    handler: addon._handlers.get('kitty'),
    storage: addon._storage,
    drawImage
  }
}

export const write = (h, sequence) => new Promise((resolve) => h.terminal.write(sequence, resolve))
export const source = (bytes = 4) => ({
  data: new Blob([new Uint8Array(bytes)]),
  width: bytes / 4,
  height: 1,
  format: 32
})
export const physical = (h, id) => {
  const bitmap = new TrackedBitmap()
  h.handler._kittyStorage.addImage(id, bitmap, true, 'top', 0)
  return bitmap
}
export const render = (h) => {
  h.drawImage.mockClear()
  h.storage.render({ start: 0, end: 5 })
  return h.drawImage.mock.calls.map((call) => call[0])
}

export function countPhysicalOwnershipTraversals(kitty) {
  const reverse = kitty._storageIdToKittyId
  const counts = { reverse: 0, siblings: 0 }
  const observedSets = new Set()
  for (const owner of Map.prototype.values.call(reverse)) {
    const siblings = owner?.storageIds
    if (!(siblings instanceof Set) || observedSets.has(siblings)) {
      continue
    }
    observedSets.add(siblings)
    for (const method of [Symbol.iterator, 'values']) {
      const original = Set.prototype[method]
      vi.spyOn(siblings, method).mockImplementation(function* () {
        for (const id of original.call(siblings)) {
          counts.siblings++
          yield id
        }
      })
    }
  }
  for (const method of [Symbol.iterator, 'keys', 'values', 'entries']) {
    const original = Map.prototype[method]
    vi.spyOn(reverse, method).mockImplementation(function* () {
      for (const entry of original.call(reverse)) {
        counts.reverse++
        yield entry
      }
    })
  }
  return counts
}
