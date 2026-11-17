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

describe('Kitty virtual placement lifecycle', () => {
  it('keeps alternate-buffer prototypes across ordinary image placement and releases them on exit', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, '\x1b[?1049h')
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, `${placeholderCells(7)}\r\n`)
      const virtual = h.bitmaps[0]
      await writeKitty(h.terminal, 'a=T,f=100,i=8', PNG)
      expect(render(h).filter((call) => call[0] === virtual)).toHaveLength(2)
      await write(h.terminal, '\x1b[?1049l')
      expect(h.storage._images.size).toBe(0)
      expect(h.kitty._virtualPlacements.size).toBe(0)
      expect(virtual.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('discards a virtual decode completing after disposal', async () => {
    const h = createPlaceholderTerminal()
    try {
      let finishDecode
      h.addon._handlers.get('kitty')._createBitmap = () =>
        new Promise((resolve) => {
          finishDecode = resolve
        })
      const decoding = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await vi.waitFor(() => expect(finishDecode).toBeTypeOf('function'))
      h.addon.dispose()
      const bitmap = new TrackedBitmap()
      finishDecode(bitmap)
      await decoding
      expect(h.storage._images.size).toBe(0)
      expect(h.kitty._virtualPlacements.size).toBe(0)
      expect(bitmap.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })
})
