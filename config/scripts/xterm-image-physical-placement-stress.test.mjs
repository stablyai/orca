import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminal,
  countPhysicalOwnershipTraversals,
  physical,
  render,
  source,
  write
} from './xterm-image-physical-placement-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('main physical ownership cleanup cost', () => {
  it('retires 2048 retained placements with constant old-owner callbacks and one bulk ownership traversal', async () => {
    const count = 2048
    const h = createTerminal({ cols: count })
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const bitmaps = [physical(h, 7)]
      const oldestId = kitty.kittyIdToStorageId.get(7)
      for (let index = 1; index < count; index++) {
        bitmaps.push(physical(h, 7))
      }
      const latestId = kitty.kittyIdToStorageId.get(7)
      const reverse = kitty._storageIdToKittyId
      const counts = countPhysicalOwnershipTraversals(kitty)
      h.storage.deleteImage(oldestId)
      expect(counts).toEqual({ reverse: 0, siblings: 0 })
      expect(kitty.kittyIdToStorageId.get(7)).toBe(latestId)
      expect(kitty.images.has(7)).toBe(true)
      expect(render(h)).toHaveLength(count - 1)
      kitty.deleteAll()
      expect(counts).toEqual({ reverse: count - 1, siblings: 0 })
      expect(reverse.size).toBe(0)
      expect(kitty.images.size).toBe(0)
      for (const bitmap of bitmaps) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
      await write(h, '\x1b[1;1H')
      kitty.storeImage(7, source())
      const reused = physical(h, 7)
      expect(render(h)).toEqual([reused])
      kitty.deleteAll()
      expect(reused.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('FIFO retirement of 2048 distinct image owners performs no global or sibling traversal', () => {
    const count = 2048
    const h = createTerminal({ cols: count })
    try {
      const kitty = h.handler._kittyStorage
      const bitmaps = []
      const storageIds = []
      for (let id = 1; id <= count; id++) {
        kitty.storeImage(id, source())
        bitmaps.push(physical(h, id))
        storageIds.push(kitty.kittyIdToStorageId.get(id))
      }
      const counts = countPhysicalOwnershipTraversals(kitty)
      for (const id of storageIds) {
        h.storage.deleteImage(id)
      }
      expect(counts).toEqual({ reverse: 0, siblings: 0 })
      expect(kitty.images.size).toBe(0)
      expect(kitty.kittyIdToStorageId.size).toBe(0)
      expect(kitty._storageIdToKittyId.size).toBe(0)
      for (const bitmap of bitmaps) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
      expect(render(h)).toEqual([])
    } finally {
      h.terminal.dispose()
    }
  })

  it('newest-first retirement of 2048 repeated placements selects at most one surviving owner per callback', () => {
    const count = 2048
    const h = createTerminal({ cols: count })
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const bitmaps = []
      const storageIds = []
      for (let index = 0; index < count; index++) {
        bitmaps.push(physical(h, 7))
        storageIds.push(kitty.kittyIdToStorageId.get(7))
      }
      const counts = countPhysicalOwnershipTraversals(kitty)
      for (let index = count - 1; index >= 0; index--) {
        h.storage.deleteImage(storageIds[index])
        expect(kitty.images.has(7)).toBe(index > 0)
        const survivor = kitty.kittyIdToStorageId.get(7)
        if (index > 0) {
          expect(kitty._storageIdToKittyId.has(survivor)).toBe(true)
        } else {
          expect(survivor).toBeUndefined()
        }
      }
      expect(counts.reverse).toBe(0)
      expect(counts.siblings).toBeLessThanOrEqual(count - 1)
      expect(kitty._storageIdToKittyId.size).toBe(0)
      for (const bitmap of bitmaps) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
      expect(render(h)).toEqual([])
    } finally {
      h.terminal.dispose()
    }
  })

  it('cursor-reversed marker trimming retires repeated placements without scanning every sibling', async () => {
    const count = 64
    const h = createTerminal({ cols: 2, rows: count, scrollback: 0 })
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const bitmaps = []
      for (let row = count; row > 0; row--) {
        await write(h, `\x1b[${row};1H`)
        bitmaps.push(physical(h, 7))
      }
      const counts = countPhysicalOwnershipTraversals(kitty)
      await write(h, `\x1b[${count};1H`)
      for (let index = count - 1; index >= 0; index--) {
        await write(h, '\n')
        expect(bitmaps[index].close).toHaveBeenCalledOnce()
        if (index > 0) {
          expect(bitmaps[index - 1].close).not.toHaveBeenCalled()
        }
        expect(kitty.images.has(7)).toBe(index > 0)
      }
      expect(counts.reverse).toBe(0)
      expect(counts.siblings).toBeLessThanOrEqual(count - 1)
      expect(kitty.kittyIdToStorageId.size).toBe(0)
      expect(kitty._storageIdToKittyId.size).toBe(0)
      for (const bitmap of bitmaps) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
    } finally {
      h.terminal.dispose()
    }
  })
})
