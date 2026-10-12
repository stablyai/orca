import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminal,
  physical,
  render,
  source,
  TrackedBitmap,
  write
} from './xterm-image-physical-placement-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('main physical placement ownership', () => {
  it('overlapping replacement retains source bytes and their existing eviction order', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      kitty.storeImage(8, source())
      const older = physical(h, 7)
      await write(h, '\x1b[1;1H')
      const newer = physical(h, 7)
      expect(older.close).toHaveBeenCalledOnce()
      expect(newer.close).not.toHaveBeenCalled()
      expect([...kitty.images.keys()]).toEqual([7, 8])
      expect(kitty.getImage(7).data.size).toBe(4)
      expect(render(h)).toEqual([newer])
    } finally {
      h.terminal.dispose()
    }
  })

  it('failed placement retains source order and releases the transient handoff guard', () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      kitty.storeImage(8, source())
      const older = physical(h, 7)
      const oldId = kitty.kittyIdToStorageId.get(7)
      const rejected = new TrackedBitmap()
      vi.spyOn(h.storage, 'addImage').mockImplementationOnce(() => {
        h.storage.deleteImage(oldId)
        throw new Error('placement failed')
      })
      expect(() => kitty.addImage(7, rejected, true, 'top', 0)).toThrow('placement failed')
      rejected.close()
      expect(older.close).toHaveBeenCalledOnce()
      expect([...kitty.images.keys()]).toEqual([7, 8])
      const next = physical(h, 7)
      h.storage.deleteImage(kitty.kittyIdToStorageId.get(7))
      expect(next.close).toHaveBeenCalledOnce()
      expect(kitty.images.has(7)).toBe(false)
      expect(kitty.images.has(8)).toBe(true)
    } finally {
      h.terminal.dispose()
    }
  })

  it('replacing an unplaced source in an over-cap placed cache preserves existing count policy', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      for (let id = 1; id <= 260; id++) {
        kitty.storeImage(id, source())
        physical(h, id)
        await write(h, '\r\n')
      }
      kitty.storeImage(1000, source())
      expect(kitty.images.size).toBe(261)
      const retainedIds = [...kitty.images.keys()]
      kitty.storeImage(1000, source(8))
      expect([...kitty.images.keys()]).toEqual(retainedIds)
      expect(kitty.getImage(1000).data.size).toBe(8)
    } finally {
      h.terminal.dispose()
    }
  })
  it('deleteAll releases both placements and leaves an unrelated protocol bitmap alone', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const first = physical(h, 7)
      await write(h, '\x1b[3;1H')
      const second = physical(h, 7)
      await write(h, '\x1b[5;1H')
      const unrelated = new TrackedBitmap()
      h.storage.addImage(unrelated, { scrolling: true, layer: 'top', zIndex: 0, cursorPos: 'iip' })
      expect(render(h)).toEqual([first, second, unrelated])
      kitty.deleteAll()
      expect(first.close).toHaveBeenCalledOnce()
      expect(second.close).toHaveBeenCalledOnce()
      expect(unrelated.close).not.toHaveBeenCalled()
      expect(render(h)).toEqual([unrelated])
    } finally {
      h.terminal.dispose()
    }
  })

  it('deleteById releases every matching placement while preserving another image', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      kitty.storeImage(8, source())
      const first = physical(h, 7)
      await write(h, '\x1b[3;1H')
      const second = physical(h, 7)
      await write(h, '\x1b[5;1H')
      const sibling = physical(h, 8)
      kitty.deleteById(7)
      expect(first.close).toHaveBeenCalledOnce()
      expect(second.close).toHaveBeenCalledOnce()
      expect(sibling.close).not.toHaveBeenCalled()
      expect(kitty.images.has(8)).toBe(true)
      expect(render(h)).toEqual([sibling])
    } finally {
      h.terminal.dispose()
    }
  })

  it('replacing an encoded image releases all its old physical placements', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const first = physical(h, 7)
      await write(h, '\x1b[3;1H')
      const second = physical(h, 7)
      kitty.storeImage(7, source(8))
      expect(first.close).toHaveBeenCalledOnce()
      expect(second.close).toHaveBeenCalledOnce()
      expect(kitty.getImage(7).data.size).toBe(8)
      expect(render(h)).toEqual([])
    } finally {
      h.terminal.dispose()
    }
  })

  it('evicting an older physical placement preserves the newest bitmap and encoded source', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const older = physical(h, 7)
      const oldId = kitty.kittyIdToStorageId.get(7)
      await write(h, '\x1b[3;1H')
      const newer = physical(h, 7)
      h.storage.deleteImage(oldId)
      expect(older.close).toHaveBeenCalledOnce()
      expect(newer.close).not.toHaveBeenCalled()
      expect(kitty.images.has(7)).toBe(true)
      expect(render(h)).toEqual([newer])
      kitty.deleteById(7)
      expect(newer.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('evicting the newest physical placement leaves the older owner deletable with its source intact', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const older = physical(h, 7)
      await write(h, '\x1b[3;1H')
      const newer = physical(h, 7)
      h.storage.deleteImage(kitty.kittyIdToStorageId.get(7))
      expect(newer.close).toHaveBeenCalledOnce()
      expect(older.close).not.toHaveBeenCalled()
      expect(kitty.images.has(7)).toBe(true)
      expect(render(h)).toEqual([older])
      kitty.deleteById(7)
      expect(older.close).toHaveBeenCalledOnce()
      expect(render(h)).toEqual([])
    } finally {
      h.terminal.dispose()
    }
  })

  it('shared storage reset closes every owner once before image IDs are reused', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      kitty.storeImage(7, source())
      const first = physical(h, 7)
      await write(h, '\x1b[3;1H')
      const second = physical(h, 7)
      h.addon.reset()
      expect(first.close).toHaveBeenCalledOnce()
      expect(second.close).toHaveBeenCalledOnce()
      kitty.storeImage(7, source())
      const replacement = physical(h, 7)
      kitty.deleteAll()
      expect(replacement.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('source pressure still classifies an older physical owner as placed after the latest retires', async () => {
    const h = createTerminal()
    try {
      const kitty = h.handler._kittyStorage
      h.addon.storageLimit = 0.5
      kitty.storeImage(7, source(200_000))
      const older = physical(h, 7)
      kitty.storeImage(8, source(200_000))
      await write(h, '\x1b[3;1H')
      const newer = physical(h, 7)
      h.storage.deleteImage(kitty.kittyIdToStorageId.get(7))
      kitty.storeImage(9, source(200_000))
      expect(kitty.images.has(7)).toBe(true)
      expect(kitty.images.has(8)).toBe(false)
      expect(older.close).not.toHaveBeenCalled()
      expect(newer.close).toHaveBeenCalledOnce()
      expect(render(h)).toEqual([older])
    } finally {
      h.terminal.dispose()
    }
  })
})
