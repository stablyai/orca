import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
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
  return { terminal, addon, handler: addon._handlers.get('kitty') }
}

function writeKitty(terminal, command, payload) {
  return new Promise((resolve) => terminal.write(`\x1b_G${command};${payload}\x1b\\`, resolve))
}

describe('xterm image memory contract', () => {
  it('does not emit a reply when evicting an id-less upload', async () => {
    const { terminal } = createTerminal()
    const replies = []
    terminal.onData((data) => replies.push(data))
    try {
      await writeKitty(terminal, 'a=t,f=32,s=1,v=1,m=1', 'AAAA')
      await writeKitty(terminal, 'a=t,f=32,s=1,v=1,i=1,m=1,q=2', 'AAAA')
      await writeKitty(terminal, 'a=t,f=32,s=1,v=1,i=2,m=1,q=2', 'AAAA')
      expect(replies).toEqual([])
    } finally {
      terminal.dispose()
    }
  })

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
    const { terminal, handler } = createTerminal({ storageLimit: 0.5 })
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

  it('evicts unplaced payloads before displayed ones', async () => {
    const { terminal, handler } = createTerminal({ storageLimit: 0.5 })
    const storage = handler._kittyStorage
    const payload = Buffer.alloc(200_000, 1).toString('base64')
    try {
      await writeKitty(terminal, 'a=t,f=32,s=250,v=200,i=1,q=2', payload)
      await writeKitty(terminal, 'a=t,f=32,s=250,v=200,i=2,q=2', payload)
      // Placement bookkeeping only; a real addImage needs a canvas this env lacks.
      storage._kittyIdToStorageId.set(1, 1001)
      storage._storageIdToKittyId.set(1001, 1)
      await writeKitty(terminal, 'a=t,f=32,s=250,v=200,i=3,q=2', payload)
      expect(storage.getImage(1)).toBeDefined()
      expect(storage.getImage(2)).toBeUndefined()
      expect(storage.getImage(3).data.size).toBe(200_000)
    } finally {
      terminal.dispose()
    }
  })

  it('stores an image larger than the byte budget rather than acking a dropped one', async () => {
    const { terminal, handler } = createTerminal({ storageLimit: 0.5 })
    const payload = Buffer.alloc(600_000, 1).toString('base64')
    try {
      await writeKitty(terminal, 'a=t,f=32,s=500,v=300,i=1,q=2', payload)
      expect(handler._kittyStorage.getImage(1).data.size).toBe(600_000)
    } finally {
      terminal.dispose()
    }
  })
})
