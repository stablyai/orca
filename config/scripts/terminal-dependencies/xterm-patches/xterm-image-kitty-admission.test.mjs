import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  PNG,
  TrackedBitmap,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('virtual prototype admission before replacement retirement', () => {
  it('rejects a decoded source larger than the current shared pixel budget', async () => {
    const h = createPlaceholderTerminal()
    const oversized = new TrackedBitmap(3000, 3000)
    vi.stubGlobal('createImageBitmap', async () => oversized)
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      expect(h.storage._images.size).toBe(0)
      expect(h.kitty._virtualStorageIds.size).toBe(0)
      expect(oversized.close).toHaveBeenCalledOnce()
      expect(h.addon.storageUsage).toBeLessThanOrEqual(h.addon.storageLimit)
    } finally {
      h.terminal.dispose()
    }
  })

  it('bounds markerless prototypes across distinct sources while allowing replacement at the bound', async () => {
    const h = createPlaceholderTerminal()
    vi.stubGlobal('createImageBitmap', async () => {
      const bitmap = new TrackedBitmap(1, 1)
      h.bitmaps.push(bitmap)
      return bitmap
    })
    try {
      for (let id = 1; id <= 256; id++) {
        await writeKitty(h.terminal, `a=T,f=100,i=${id},U=1,p=10,c=1,r=1`, PNG)
      }
      expect(h.kitty._virtualStorageIds.size).toBe(256)
      await writeKitty(h.terminal, 'a=T,f=100,i=257,U=1,p=10,c=1,r=1', PNG)
      expect(h.kitty._virtualStorageIds.size).toBe(256)
      expect(h.storage._images.size).toBe(256)
      expect(h.bitmaps[256].close).toHaveBeenCalledOnce()
      const replaced = h.bitmaps[0]
      await writeKitty(h.terminal, 'a=T,f=100,i=1,U=1,p=10,c=1,r=1', PNG)
      expect(h.kitty._virtualStorageIds.size).toBe(256)
      expect(h.storage._images.size).toBe(256)
      expect(replaced.close).toHaveBeenCalledOnce()
      expect(h.bitmaps[257].close).not.toHaveBeenCalled()
      h.addon.reset()
      expect(h.kitty._virtualStorageIds.size).toBe(0)
      expect(h.storage._images.size).toBe(0)
      for (const bitmap of h.bitmaps) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
    } finally {
      h.terminal.dispose()
    }
  })

  it('counts separate named placements of one source against the same bound', async () => {
    const h = createPlaceholderTerminal()
    vi.stubGlobal('createImageBitmap', async () => new TrackedBitmap(1, 1))
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=1,c=1,r=1', PNG)
      for (let placement = 2; placement <= 257; placement++) {
        await writeKitty(h.terminal, `a=p,i=7,U=1,p=${placement},c=1,r=1`)
      }
      expect(h.kitty._virtualStorageIds.size).toBe(256)
      expect(h.kitty._virtualPlacements.get(7).size).toBe(256)
    } finally {
      h.terminal.dispose()
    }
  })

  it('reads a reduced live budget and safely retires a failed current replacement', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      const previous = h.bitmaps[0]
      const oversized = new TrackedBitmap(400, 400)
      let finish
      vi.stubGlobal(
        'createImageBitmap',
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      h.addon.storageLimit = 0.5
      finish(oversized)
      await writing
      expect(h.kitty._virtualStorageIds.size).toBe(0)
      expect(h.storage._images.size).toBe(0)
      expect(previous.close).toHaveBeenCalledOnce()
      expect(oversized.close).toHaveBeenCalledOnce()
      expect(h.addon.storageUsage).toBeLessThanOrEqual(0.5)
    } finally {
      h.terminal.dispose()
    }
  })
})
