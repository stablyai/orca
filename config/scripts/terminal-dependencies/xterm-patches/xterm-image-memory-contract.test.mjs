import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(
  new URL('../../xterm-image-memory-contract.test.mjs', import.meta.url)
)
const { Terminal } = require('@xterm/xterm')
const { ImageAddon } = require('@xterm/addon-image')

function createTerminal(options = {}) {
  const terminal = new Terminal({ allowProposedApi: true })
  const addon = new ImageAddon({
    enableSizeReports: false,
    storageLimit: 32,
    kittySizeLimit: 8 * 1024 * 1024,
    ...options
  })
  terminal.loadAddon(addon)
  const handler = addon._handlers.get('kitty')
  if (options.kittyStorageLimit !== undefined) {
    handler._kittyStorage._storage.setLimit(options.kittyStorageLimit)
  }
  return { terminal, addon, handler }
}

function writeKitty(terminal, command, payload) {
  return new Promise((resolve) => terminal.write(`\x1b_G${command};${payload}\x1b\\`, resolve))
}

describe('xterm image memory contract', () => {
  it('bounds abandoned uploads by retained decoder capacity and accepts a continuation', async () => {
    const { terminal, handler } = createTerminal()
    try {
      for (let id = 1; id <= 40; id++) {
        await writeKitty(terminal, `a=t,f=32,s=1,v=1,i=${id},m=1,q=2`, 'AAAA')
        const pending = [...handler._pendingTransmissions.values()]
        const retainedBytes = pending.reduce(
          (total, upload) => total + upload.decoder._mem.buffer.byteLength,
          0
        )
        expect(retainedBytes).toBeLessThanOrEqual(32_000_000)
        expect(pending.length).toBeLessThanOrEqual(2)
      }
      await writeKitty(terminal, 'm=0,q=2', 'AA==')
      expect(handler._kittyStorage.getImage(40).data.size).toBe(4)
      terminal.dispose()
      expect(handler._pendingTransmissions.size).toBe(0)
    } finally {
      terminal.dispose()
    }
  })

  it('evicts transmitted images by byte size before placement', async () => {
    const { terminal, handler } = createTerminal({ storageLimit: 12, kittyStorageLimit: 0.5 })
    const payload = Buffer.alloc(200_000, 1).toString('base64')
    try {
      for (let id = 1; id <= 4; id++) {
        await writeKitty(terminal, `a=t,f=32,s=250,v=200,i=${id},q=2`, payload)
        const retainedBytes = [...handler._kittyStorage.images.values()].reduce(
          (total, image) => total + image.data.size,
          0
        )
        expect(retainedBytes).toBeLessThanOrEqual(500_000)
      }
      expect(handler._kittyStorage.getImage(1)).toBeUndefined()
      expect(handler._kittyStorage.getImage(3).data.size).toBe(200_000)
      expect(handler._kittyStorage.getImage(4).data.size).toBe(200_000)
      await writeKitty(terminal, 'a=d,d=A,q=2', '')
      expect(handler._kittyStorage.images.size).toBe(0)
    } finally {
      terminal.dispose()
    }
  })
})
