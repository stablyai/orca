import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  placeholderCells,
  render,
  TrackedBitmap,
  write
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

function source(bytes = 1) {
  return { data: new Blob([new Uint8Array(bytes)]), width: 1, height: 1, format: 100 }
}

function place(h, id, placement = 0) {
  const bitmap = new TrackedBitmap(1, 1)
  h.kitty.addVirtualPlacement(id, placement, bitmap, 1, 1)
  return bitmap
}

describe('encoded sources and decoded placements have independent ownership', () => {
  it('evicts an offscreen source before a source named by visible cells', async () => {
    const h = createPlaceholderTerminal()
    try {
      h.storage.setLimit(0.5)
      h.kitty.storeImage(7, source(200_000))
      const visible = place(h, 7)
      await write(h.terminal, placeholderCells(7, 0, 1, 1))
      h.kitty.storeImage(8, source(200_000))
      const offscreen = place(h, 8)
      h.kitty.storeImage(9, source(200_000))
      expect(h.kitty.getImage(7)).toBeDefined()
      expect(h.kitty.getImage(8)).toBeUndefined()
      expect(render(h).map((call) => call[0])).toEqual([visible])
      expect(visible.close).not.toHaveBeenCalled()
      expect(offscreen.close).not.toHaveBeenCalled()
    } finally {
      h.terminal.dispose()
    }
  })

  it('keeps a visible bitmap when its encoded source must be evicted', async () => {
    const h = createPlaceholderTerminal()
    try {
      h.storage.setLimit(0.5)
      h.kitty.storeImage(7, source(400_000))
      const visible = place(h, 7)
      await write(h.terminal, placeholderCells(7, 0, 1, 1))
      h.kitty.storeImage(8, source(400_000))
      expect(h.kitty.getImage(7)).toBeUndefined()
      expect(render(h).map((call) => call[0])).toEqual([visible])
      expect(visible.close).not.toHaveBeenCalled()
      h.kitty.deleteAll()
      expect(h.storage._images.size).toBe(0)
      expect(visible.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('bounds encoded source count even when every image has a decoded placement', () => {
    const h = createPlaceholderTerminal()
    try {
      for (let id = 1; id <= 257; id++) {
        h.kitty.storeImage(id, source())
        place(h, id)
      }
      expect(h.kitty.images.size).toBeLessThanOrEqual(256)
      expect(h.storage._images.size).toBe(257)
      expect(h.kitty._virtualStorageIds.size).toBe(257)
    } finally {
      h.terminal.dispose()
    }
  })

  it('bounds tiny bitmap handles and placement metadata independently of pixel bytes', async () => {
    const h = createPlaceholderTerminal()
    try {
      h.kitty.storeImage(7, source())
      const visible = place(h, 7, 1)
      await write(h.terminal, placeholderCells(7, 1, 1, 1))
      const offscreen = place(h, 7, 2)
      for (let placement = 3; placement <= 4097; placement++) {
        place(h, 7, placement)
      }
      expect(h.storage._images.size).toBe(4096)
      expect(h.kitty._virtualStorageIds.size).toBe(4096)
      expect(h.kitty._virtualPlacements.get(7).size).toBe(4096)
      expect(visible.close).not.toHaveBeenCalled()
      expect(offscreen.close).toHaveBeenCalledOnce()
      expect(render(h).map((call) => call[0])).toEqual([visible])
    } finally {
      h.terminal.dispose()
    }
  })
})
