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

  it('retransmitting an image ID releases all old virtual placements', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=11,c=1,r=1')
      const previous = [...h.bitmaps]
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=12,c=2,r=2', PNG)
      expect(h.storage._images.size).toBe(1)
      for (const bitmap of previous) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
      await write(h.terminal, `${placeholderCells(7, 10)}\r\n${placeholderCells(7, 12)}`)
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it('can create a prototype from an encoded image after its physical bitmap is evicted', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,C=1', PNG)
      h.storage._pixelLimit = 200
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      expect(h.kitty.getImage(7)).toBeDefined()
      await writeKitty(h.terminal, 'a=p,U=1,i=7,c=2,r=2')
      await write(h.terminal, placeholderCells(7))
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it('deletes physical placements while preserving a prototype of the same image on d=A', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=p,i=7,C=1')
      expect(h.kitty.kittyIdToStorageId.size).toBe(1)
      await writeKitty(h.terminal, 'a=d,d=A,q=2')
      expect(h.kitty.kittyIdToStorageId.size).toBe(0)
      expect(h.storage._images.size).toBe(1)
      expect(h.bitmaps[1].close).toHaveBeenCalledOnce()
      await write(h.terminal, placeholderCells(7))
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['reset', 'dispose'])('discards a virtual decode completing after %s', async (action) => {
    const h = createPlaceholderTerminal()
    try {
      let finishDecode
      h.addon._handlers.get('kitty')._createBitmap = () =>
        new Promise((resolve) => {
          finishDecode = resolve
        })
      const decoding = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await vi.waitFor(() => expect(finishDecode).toBeTypeOf('function'))
      h.addon[action]()
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
