import { createRequire } from 'node:module'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(
  new URL('../../xterm-image-lifecycle-contract.test.mjs', import.meta.url)
)
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
})
