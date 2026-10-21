import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { ImageAddon } = require('@xterm/addon-image')

afterEach(() => vi.unstubAllGlobals())

it('scales visible tiles without allocating a full enlarged image on font zoom', () => {
  const terminal = new Terminal({ allowProposedApi: true })
  const addon = new ImageAddon({ enableSizeReports: false, storageLimit: 32 })
  terminal.loadAddon(addon)
  const createCanvas = vi.fn(() => ({ getContext: () => ({ drawImage: vi.fn() }) }))
  vi.stubGlobal('document', { createElement: createCanvas })
  const renderer = addon._renderer
  vi.spyOn(renderer, 'cellSize', 'get').mockReturnValue({ width: 90, height: 90 })
  const drawImage = vi.fn()
  renderer._layers.set('top', { drawImage, clearRect() {}, canvas: { remove() {} } })
  const original = { width: 2000, height: 2000 }
  const spec = {
    orig: original,
    actual: original,
    origCellSize: { width: 10, height: 10 },
    actualCellSize: { width: 10, height: 10 },
    layer: 'top'
  }
  try {
    renderer.draw(spec, 201, 2, 3)
    expect(createCanvas).not.toHaveBeenCalled()
    expect(drawImage).toHaveBeenCalledWith(original, 10, 10, 10, 10, 180, 270, 90, 90)
    const tile = renderer.extractTile(spec, 201)
    expect(tile.width).toBe(90)
    expect(tile.height).toBe(90)
  } finally {
    terminal.dispose()
  }
})
