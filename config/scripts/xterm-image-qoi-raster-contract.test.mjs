import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../src/shared/__fixtures__/terminal-raster-red.json'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { ImageAddon } = require('@xterm/addon-image')

class RawPixels {
  constructor(data, width, height) {
    this.data = data
    this.width = width
    this.height = height
  }
}

class Bitmap {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.close = vi.fn()
  }
}

function terminal() {
  vi.stubGlobal('ImageData', RawPixels)
  const core = new Terminal({ allowProposedApi: true, logLevel: 'off' })
  const addon = new ImageAddon({ enableSizeReports: false, showPlaceholder: false })
  core.loadAddon(addon)
  return { core, addon, storage: addon._storage }
}

const sequence = `\x1b]1337;File=inline=1;width=1px;height=1px;preserveAspectRatio=0:${fixtures.qoi}\x07AFTER`
const write = (core) => new Promise((resolve) => core.write(sequence, resolve))
afterEach(() => vi.unstubAllGlobals())

describe('QOI bitmap resize ownership', () => {
  it('releases the intermediate bitmap and retains the final image until reset', async () => {
    const h = terminal()
    const original = new Bitmap(8, 8)
    const resized = new Bitmap(1, 1)
    vi.stubGlobal('createImageBitmap', async (source, options) =>
      source instanceof RawPixels && !options.resizeWidth ? original : resized
    )
    try {
      await write(h.core)
      expect(original.close).toHaveBeenCalledOnce()
      expect(resized.close).not.toHaveBeenCalled()
      expect([...h.storage._images.values()][0].orig).toBe(resized)
      h.addon.reset()
      expect(resized.close).toHaveBeenCalledOnce()
      expect(h.core.buffer.active.getLine(0).translateToString(true)).toContain('AFTER')
    } finally {
      h.core.dispose()
    }
  })

  it.each(['throw', 'reject'])(
    'releases decoded pixels on resize %s and consumes the suffix',
    async (failure) => {
      const h = terminal()
      const original = new Bitmap(8, 8)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubGlobal('createImageBitmap', (source, options) => {
        if (source instanceof RawPixels) {
          return Promise.resolve(
            options.resizeWidth ? new Bitmap(options.resizeWidth, options.resizeHeight) : original
          )
        }
        if (failure === 'throw') {
          throw new Error('native resize failed')
        }
        return Promise.reject(new Error('native resize failed'))
      })
      try {
        await write(h.core)
        expect(original.close).toHaveBeenCalledOnce()
        expect(h.storage._images.size).toBe(0)
        expect(h.core.buffer.active.getLine(0).translateToString(true)).toBe('AFTER')
      } finally {
        warning.mockRestore()
        h.core.dispose()
      }
    }
  )

  it('closes both bitmaps when reset interrupts the pending resize', async () => {
    const h = terminal()
    const original = new Bitmap(8, 8)
    const resized = new Bitmap(1, 1)
    let finish
    const decode = vi.fn((source, options) =>
      source instanceof RawPixels
        ? Promise.resolve(options.resizeWidth ? resized : original)
        : new Promise((resolve) => {
            finish = resolve
          })
    )
    vi.stubGlobal('createImageBitmap', decode)
    try {
      const pending = write(h.core)
      await vi.waitFor(() => expect(decode).toHaveBeenCalled())
      expect(decode.mock.calls[0][1]).toEqual({ premultiplyAlpha: 'premultiply' })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      h.addon.reset()
      finish(resized)
      await pending
      expect(original.close).toHaveBeenCalledOnce()
      expect(resized.close).toHaveBeenCalledOnce()
      expect(h.storage._images.size).toBe(0)
      expect(h.core.buffer.active.getLine(0).translateToString(true)).toBe('AFTER')
    } finally {
      h.core.dispose()
    }
  })
})
