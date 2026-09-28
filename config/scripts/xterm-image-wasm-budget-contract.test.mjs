import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { ImageAddon } = require('@xterm/addon-image')

// V8 caps live wasm memories per renderer (~124 under Electron's sandbox), so
// these contracts pin that idle terminals hold none and that exhaustion drops
// an image instead of wedging the terminal's write queue.

const SIXEL_RED_REGISTER_1 = '\x1bPq#1;2;100;0;0#1~\x1b\\'
const SIXEL_USE_REGISTER_1 = '\x1bPq#1~\x1b\\'
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const IIP_PNG = `\x1b]1337;File=inline=1;size=${Buffer.from(PNG_1X1, 'base64').length}:${PNG_1X1}\x07`

class TrackedBitmap {
  width = 1
  height = 1
  close = vi.fn()
}

function stubCanvasGlobals() {
  const painted = []
  vi.stubGlobal('ImageBitmap', TrackedBitmap)
  vi.stubGlobal('window', { ImageBitmap: TrackedBitmap })
  vi.stubGlobal('createImageBitmap', async () => new TrackedBitmap())
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(data, width, height) {
        Object.assign(this, { data: new Uint8ClampedArray(data), width, height })
      }
    }
  )
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ putImageData: (image) => painted.push(image) })
    })
  })
  return painted
}

function createTerminal(options = {}) {
  const terminal = new Terminal({ allowProposedApi: true })
  const addon = new ImageAddon({
    enableSizeReports: false,
    storageLimit: 32,
    kittySizeLimit: 8 * 1024 * 1024,
    ...options
  })
  terminal.loadAddon(addon)
  return {
    terminal,
    addon,
    sixel: addon._handlers.get('sixel'),
    iip: addon._handlers.get('iip')
  }
}

function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve))
}

// A throw out of a handler leaves xterm's write queue waiting forever.
function writeOrWedge(terminal, data) {
  return Promise.race([
    write(terminal, data).then(() => 'parsed'),
    new Promise((resolve) => setTimeout(() => resolve('wedged'), 2000))
  ])
}

function firstPixel(image) {
  return Array.from(image.data.subarray(0, 4))
}

afterEach(() => vi.unstubAllGlobals())

describe('xterm image wasm budget', () => {
  it('keeps idle terminals free of wasm decoders', async () => {
    const panes = Array.from({ length: 300 }, () => createTerminal())
    try {
      // Let any asynchronous decoder instantiation settle.
      await new Promise((resolve) => setTimeout(resolve, 100))
      for (const { sixel, iip } of panes) {
        expect(sixel._dec).toBeUndefined()
        expect(iip._dec._inst).toBeNull()
        expect(iip._qoiDec._inst).toBeFalsy()
      }
    } finally {
      for (const { terminal } of panes) {
        terminal.dispose()
      }
    }
  })

  it('returns decoders after each SIXEL and IIP image', async () => {
    const painted = stubCanvasGlobals()
    const { terminal, addon, sixel, iip } = createTerminal()
    let added = 0
    addon.onImageAdded(() => added++)
    try {
      await write(terminal, SIXEL_RED_REGISTER_1)
      expect(painted).toHaveLength(1)
      expect(sixel._dec).toBeUndefined()

      await write(terminal, IIP_PNG)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(iip._dec._inst).toBeNull()
      expect(added).toBe(2)
    } finally {
      terminal.dispose()
    }
  })

  it('keeps SIXEL color registers across images until a terminal reset', async () => {
    const painted = stubCanvasGlobals()
    const { terminal } = createTerminal()
    try {
      await write(terminal, SIXEL_RED_REGISTER_1)
      await write(terminal, SIXEL_USE_REGISTER_1)
      expect(firstPixel(painted[1])).toEqual([255, 0, 0, 255])

      await write(terminal, '\x1bc')
      await write(terminal, SIXEL_USE_REGISTER_1)
      expect(firstPixel(painted[2])).not.toEqual([255, 0, 0, 255])
    } finally {
      terminal.dispose()
    }
  })

  it('drops images without wedging the parser when wasm memory is exhausted', async () => {
    stubCanvasGlobals()
    // A pixelLimit no other test uses keeps the shared SIXEL pool empty for this key.
    const { terminal, addon } = createTerminal({ pixelLimit: 1234567 })
    const replies = []
    terminal.onData((data) => replies.push(data))
    function exhausted() {
      throw new RangeError('WebAssembly.Memory(): could not allocate memory')
    }
    vi.stubGlobal('WebAssembly', { ...WebAssembly, Memory: exhausted, Instance: exhausted })
    try {
      expect(await writeOrWedge(terminal, '\x1b_Ga=T,f=32,s=1,v=1,i=7;AAAA/w==\x1b\\')).toBe(
        'parsed'
      )
      expect(await writeOrWedge(terminal, IIP_PNG)).toBe('parsed')
      expect(await writeOrWedge(terminal, SIXEL_USE_REGISTER_1)).toBe('parsed')
      expect(await writeOrWedge(terminal, 'after')).toBe('parsed')

      expect(addon._storage._images.size).toBe(0)
      expect(replies.join('')).toContain('ENOMEM')
      expect(terminal.buffer.active.getLine(0).translateToString(true)).toContain('after')
    } finally {
      terminal.dispose()
    }
  })
})
