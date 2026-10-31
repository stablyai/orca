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
  it.each(['i', 'I'])(
    'deletes a named physical placement with no matching prototype on d=%s',
    async (selector) => {
      const h = createPlaceholderTerminal()
      try {
        await writeKitty(h.terminal, 'a=T,f=100,i=7,p=10,C=1', PNG)
        const physical = h.bitmaps[0]
        expect(render(h).some((call) => call[0] === physical)).toBe(true)

        await writeKitty(h.terminal, `a=d,d=${selector},i=7,p=10,q=2`)

        expect(render(h)).toHaveLength(0)
        expect(h.storage._images.size).toBe(0)
        expect(physical.close).toHaveBeenCalledOnce()
        if (selector === 'i') {
          expect(h.kitty.getImage(7)).toBeDefined()
        } else {
          expect(h.kitty.getImage(7)).toBeUndefined()
        }
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it.each(['i', 'I'])(
    'keeps a different virtual prototype when deleting a named physical placement on d=%s',
    async (selector) => {
      const h = createPlaceholderTerminal({ showPlaceholder: false })
      try {
        await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=11,c=2,r=2', PNG)
        await write(h.terminal, '\x1b[4;1H')
        await writeKitty(h.terminal, 'a=p,i=7,p=10,C=1')
        await write(h.terminal, `\x1b[1;1H${placeholderCells(7, 11)}`)
        const [virtual, physical] = h.bitmaps
        expect(render(h).some((call) => call[0] === physical)).toBe(true)

        await writeKitty(h.terminal, `a=d,d=${selector},i=7,p=10,q=2`)

        const calls = render(h)
        expect(calls.filter((call) => call[0] === physical)).toHaveLength(0)
        expect(calls.filter((call) => call[0] === virtual)).toHaveLength(2)
        expect(physical.close).toHaveBeenCalledOnce()
        expect(virtual.close).not.toHaveBeenCalled()
        expect(h.kitty.getImage(7)).toBeDefined()
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it('keeps alternate-buffer prototypes across ordinary image placement and releases their pixels on exit', async () => {
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
      expect(h.kitty._virtualPlacements.size).toBe(1)
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
