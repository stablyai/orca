import { createRequire } from 'node:module'
import { crc32, deflateRawSync, deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { ImageAddon } = require('@xterm/addon-image')

class TrackedBitmap {
  width = 1
  height = 1
  close = vi.fn()
}

function createTerminal() {
  vi.stubGlobal('ImageBitmap', TrackedBitmap)
  vi.stubGlobal('window', { ImageBitmap: TrackedBitmap })
  const terminal = new Terminal({ allowProposedApi: true })
  const addon = new ImageAddon({
    enableSizeReports: false,
    storageLimit: 32,
    kittySizeLimit: 8 * 1024 * 1024
  })
  terminal.loadAddon(addon)
  return { terminal, addon, storage: addon._storage, kitty: addon._handlers.get('kitty') }
}

afterEach(() => vi.unstubAllGlobals())

describe('xterm image allocation lifecycle', () => {
  it('closes alternate-buffer bitmaps when images are reset', async () => {
    const { terminal, addon, storage } = createTerminal()
    try {
      await new Promise((resolve) => terminal.write('\x1b[?1049h', resolve))
      const bitmap = new TrackedBitmap()
      storage.addImage(bitmap, { scrolling: true, layer: 'top', zIndex: 0, cursorPos: 'iip' })
      expect(storage._images.size).toBe(1)
      addon.reset()
      expect(storage._images.size).toBe(0)
      expect(bitmap.close).toHaveBeenCalledOnce()
    } finally {
      terminal.dispose()
    }
  })

  it.each(['reset', 'dispose'])(
    'discards IIP decode that finishes after addon %s',
    async (action) => {
      const { terminal, addon, storage } = createTerminal()
      try {
        let finishDecode
        vi.stubGlobal(
          'createImageBitmap',
          () =>
            new Promise((resolve) => {
              finishDecode = resolve
            })
        )
        const iip = addon._handlers.get('iip')
        const png =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
        const payload = Uint32Array.from(`File=inline=1:${png}`, (char) => char.codePointAt(0))
        iip.start()
        iip.put(payload, 0, payload.length)
        const decoding = iip.end(true)
        expect(finishDecode).toBeTypeOf('function')
        addon[action]()
        const bitmap = new TrackedBitmap()
        finishDecode(bitmap)
        await decoding
        expect(storage._images.size).toBe(0)
        expect(bitmap.close).toHaveBeenCalledOnce()
      } finally {
        terminal.dispose()
      }
    }
  )

  it.each(['hide', 'dispose'])('closes placeholder bitmap finishing after %s', async (action) => {
    const { terminal, addon } = createTerminal()
    try {
      const renderer = addon._renderer
      const context = {
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: () => {},
        drawImage: () => {}
      }
      vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) })
      vi.stubGlobal('screen', { width: 800 })
      let finishDecode
      vi.stubGlobal(
        'createImageBitmap',
        () =>
          new Promise((resolve) => {
            finishDecode = resolve
          })
      )
      renderer._createPlaceHolder(24)
      if (action === 'dispose') {
        addon.dispose()
      } else {
        renderer.showPlaceholder(false)
      }
      const bitmap = new TrackedBitmap()
      finishDecode(bitmap)
      await Promise.resolve()
      expect(bitmap.close).toHaveBeenCalledOnce()
      expect(renderer._placeholderBitmap).toBeUndefined()
    } finally {
      terminal.dispose()
    }
  })

  it('rejects oversized PNG headers before native bitmap allocation', async () => {
    const { terminal, kitty } = createTerminal()
    try {
      const decode = vi.fn(async () => new TrackedBitmap())
      vi.stubGlobal('createImageBitmap', decode)
      window.createImageBitmap = decode
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64'
      )
      png.writeUInt32BE(100_000, 16)
      png.writeUInt32BE(100_000, 20)
      png.writeUInt32BE(crc32(png.subarray(12, 29)), 29)
      const result = await kitty._createBitmap({ format: 100, data: new Blob([png]) }).then(
        () => 'accepted',
        () => 'rejected'
      )
      expect(decode).not.toHaveBeenCalled()
      expect(result).toBe('rejected')
    } finally {
      terminal.dispose()
    }
  })

  it.each([deflateSync, deflateRawSync])(
    'preserves valid compressed image bytes (%#)',
    async (compress) => {
      const { terminal, kitty } = createTerminal()
      try {
        const original = Buffer.from([1, 2, 3, 4])
        expect(Buffer.from(await kitty._decompressZlib(compress(original)))).toEqual(original)
      } finally {
        terminal.dispose()
      }
    }
  )

  it('contains malformed compressed streams without unhandled writer rejections', async () => {
    const { terminal, kitty } = createTerminal()
    try {
      await expect(kitty._decompressZlib(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
    } finally {
      terminal.dispose()
    }
  })

  it('rejects compressed data expanding beyond the decoded-image budget', async () => {
    const { terminal, kitty } = createTerminal()
    try {
      const compressed = deflateSync(Buffer.alloc(64 * 1024 * 1024))
      expect(compressed.byteLength).toBeLessThan(100_000)
      const result = await kitty._decompressZlib(compressed).then(
        (bytes) => ({ decodedBytes: bytes.byteLength }),
        () => ({ rejected: true })
      )
      expect(result).toEqual({ rejected: true })
    } finally {
      terminal.dispose()
    }
  })

  it.each([{ x: 1 }, { columns: 2 }])(
    'discards Kitty image reset during crop or resize (%#)',
    async (command) => {
      const { terminal, addon, storage, kitty } = createTerminal()
      try {
        const original = new TrackedBitmap()
        original.width = original.height = 10
        kitty._createBitmap = async () => original
        let finishTransform
        vi.stubGlobal(
          'createImageBitmap',
          () =>
            new Promise((resolve) => {
              finishTransform = resolve
            })
        )
        const decoding = kitty._displayImage({ id: 1 }, command)
        await Promise.resolve()
        expect(finishTransform).toBeTypeOf('function')
        addon.reset()
        const transformed = new TrackedBitmap()
        finishTransform(transformed)
        await decoding
        expect(storage._images.size).toBe(0)
        expect(original.close).toHaveBeenCalledOnce()
        expect(transformed.close).toHaveBeenCalledOnce()
      } finally {
        terminal.dispose()
      }
    }
  )

  it.each(['reset', 'dispose'])(
    'discards Kitty decode that finishes after addon %s',
    async (action) => {
      const { terminal, addon, storage, kitty } = createTerminal()
      try {
        let finishDecode
        kitty._createBitmap = () =>
          new Promise((resolve) => {
            finishDecode = resolve
          })
        const decoding = kitty._displayImage({ id: 1 }, {})
        addon[action]()
        const bitmap = new TrackedBitmap()
        finishDecode(bitmap)
        await decoding
        expect(storage._images.size).toBe(0)
        expect(bitmap.close).toHaveBeenCalledOnce()
      } finally {
        terminal.dispose()
      }
    }
  )
})
