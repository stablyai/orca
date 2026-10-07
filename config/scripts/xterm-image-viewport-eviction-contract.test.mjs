import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  placeholderCells,
  PNG,
  render,
  TrackedBitmap,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

const physical = { scrolling: true, layer: 'top', zIndex: 0, cursorPos: 'iip' }

describe('image eviction follows the displayed viewport', () => {
  it('evicts a newer offscreen image before an older image in a scrolled viewport', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, '\r\n'.repeat(12))
      await write(h.terminal, '\x1b[1;1H')
      const visible = new TrackedBitmap()
      h.storage.addImage(visible, physical)
      await write(h.terminal, '\x1b[6;1H')
      const offscreen = new TrackedBitmap()
      h.storage.addImage(offscreen, physical)
      await write(h.terminal, '\r\n'.repeat(6))
      h.terminal.scrollToLine(6)
      expect(render(h).map((call) => call[0])).toEqual([visible])
      h.storage._pixelLimit = 400
      h.storage.addImage(new TrackedBitmap(), physical)
      expect(visible.close).not.toHaveBeenCalled()
      expect(offscreen.close).toHaveBeenCalledOnce()
      expect(render(h).map((call) => call[0])).toEqual([visible])
      expect(h.storage.getUsage()).toBeLessThanOrEqual(h.storage.getLimit())
    } finally {
      h.terminal.dispose()
    }
  })

  it('evicts an unused prototype before an older prototype referenced by visible cells', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      h.storage._pixelLimit = 400
      await writeKitty(h.terminal, 'a=T,f=100,i=9,U=1,c=2,r=2', PNG)
      expect(render(h).map((call) => call[0])).toEqual([h.bitmaps[0], h.bitmaps[0]])
      expect(h.bitmaps[0].close).not.toHaveBeenCalled()
      expect(h.bitmaps[1].close).toHaveBeenCalledOnce()
      expect(h.kitty._virtualPlacements.has(8)).toBe(false)
      expect(h.kitty.getImage(8)).toBeDefined()
      expect(h.storage.getUsage()).toBeLessThanOrEqual(h.storage.getLimit())
    } finally {
      h.terminal.dispose()
    }
  })

  it('checks the named placement, not just whether its image ID appears onscreen', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,p=10,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7, 10))
      await writeKitty(h.terminal, 'a=p,i=7,p=11,U=1,c=1,r=1')
      h.storage._pixelLimit = 400
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      expect(h.kitty._virtualPlacements.get(7).has(10)).toBe(true)
      expect(h.kitty._virtualPlacements.get(7).has(11)).toBe(false)
      expect(render(h)).toHaveLength(2)
      expect(h.bitmaps[1].close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('does not protect a physical image after its cells have been erased', async () => {
    const h = createPlaceholderTerminal()
    try {
      const erased = new TrackedBitmap()
      h.storage.addImage(erased, physical)
      await write(h.terminal, '\x1b[1;1H\x1b[2K\x1b[3;1H')
      const visible = new TrackedBitmap()
      h.storage.addImage(visible, physical)
      h.storage._pixelLimit = 400
      await write(h.terminal, '\x1b[5;1H')
      h.storage.addImage(new TrackedBitmap(), physical)
      expect(erased.close).toHaveBeenCalledOnce()
      expect(visible.close).not.toHaveBeenCalled()
    } finally {
      h.terminal.dispose()
    }
  })

  it('falls back to oldest visible eviction when the visible working set fills the hard cap', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      await write(h.terminal, `\r\n${placeholderCells(8)}`)
      h.storage._pixelLimit = 400
      await writeKitty(h.terminal, 'a=T,f=100,i=9,U=1,c=2,r=2', PNG)
      expect(h.bitmaps[0].close).toHaveBeenCalledOnce()
      expect(h.bitmaps[1].close).not.toHaveBeenCalled()
      expect(h.storage.getUsage()).toBeLessThanOrEqual(h.storage.getLimit())
      expect(h.kitty.getImage(7)).toBeDefined()
    } finally {
      h.terminal.dispose()
    }
  })

  it('trims unreferenced prototypes first when reducing the budget', async () => {
    const h = createPlaceholderTerminal()
    try {
      h.addon._handlers.get('kitty')._createBitmap = async () => {
        const bitmap = new TrackedBitmap(500, 200)
        h.bitmaps.push(bitmap)
        return bitmap
      }
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=T,f=100,i=9,U=1,c=2,r=2', PNG)
      h.storage.setLimit(0.5)
      expect(h.storage.getUsage()).toBeLessThanOrEqual(0.5)
      expect(h.bitmaps[0].close).not.toHaveBeenCalled()
      expect(h.bitmaps[1].close).toHaveBeenCalledOnce()
      expect(h.bitmaps[2].close).toHaveBeenCalledOnce()
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })
})
