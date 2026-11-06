import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  DIACRITICS,
  placeholderCells,
  PLACEHOLDER,
  PNG,
  render,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('Kitty virtual placement ownership and rendering', () => {
  it('paints only at the placeholder cells and leaves the cursor unchanged', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, '\x1b[2;4H')
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      expect([h.terminal.buffer.active.cursorX, h.terminal.buffer.active.cursorY]).toEqual([3, 1])
      expect(render(h)).toHaveLength(0)
      await write(h.terminal, placeholderCells(7))
      const calls = render(h)
      expect(calls).toHaveLength(2)
      expect(calls[0].slice(1)).toEqual([0, 0, 20, 5, 30, 15, 20, 5])
      expect(calls[1].slice(1)).toEqual([0, 5, 20, 5, 0, 20, 20, 5])
    } finally {
      h.terminal.dispose()
    }
  })

  it('keeps virtual images when an ordinary image is subsequently placed', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, `${placeholderCells(7)}\r\n`)
      const virtualBitmap = h.bitmaps[0]
      await writeKitty(h.terminal, 'a=T,f=100,i=8', PNG)
      expect(render(h).filter((call) => call[0] === virtualBitmap)).toHaveLength(2)
      expect(virtualBitmap.close).not.toHaveBeenCalled()
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['i', 'I'])('releases the virtual bitmap on d=%s', async (selector) => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      expect(render(h)).toHaveLength(2)
      await writeKitty(h.terminal, `a=d,d=${selector},i=7,q=2`)
      expect(render(h)).toHaveLength(0)
      expect(h.storage._images.size).toBe(0)
      expect(h.bitmaps[0].close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['reset', 'dispose'])('releases markerless virtual bitmaps on %s', async (action) => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      h.addon[action]()
      expect(h.storage._images.size).toBe(0)
      expect(h.bitmaps[0].close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('retains distinct virtual placement IDs for the same image', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=t,f=100,i=7', PNG)
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=10,c=2,r=2')
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=11,c=1,r=1')
      await write(h.terminal, `${placeholderCells(7, 10)}\r\n${placeholderCells(7, 11, 1, 1)}`)
      expect(render(h)).toHaveLength(3)
    } finally {
      h.terminal.dispose()
    }
  })

  it('replaces a prototype without losing its encoded payload or leaking its old bitmap', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      const oldBitmap = h.bitmaps[0]
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=10,c=1,r=1')
      expect(h.kitty.getImage(7)).toBeDefined()
      expect(h.storage._images.size).toBe(1)
      expect(oldBitmap.close).toHaveBeenCalledOnce()
      await write(h.terminal, placeholderCells(7, 10, 1, 1))
      expect(render(h)).toHaveLength(1)
    } finally {
      h.terminal.dispose()
    }
  })

  it('invalidates virtual placement bookkeeping when the pixel budget evicts it', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      h.storage._pixelLimit = 200
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      expect(render(h)).toHaveLength(0)
      expect(h.bitmaps[0].close).toHaveBeenCalledOnce()
      expect(h.kitty._virtualPlacements.has(7)).toBe(false)
    } finally {
      h.terminal.dispose()
    }
  })

  it.each([0x02000007, 0x80000007, 0x80000000])('resolves unsigned image ID %i', async (id) => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, `a=T,f=100,i=${id},U=1,c=2,r=2`, PNG)
      await write(h.terminal, placeholderCells(id))
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['a', 'A'])(
    'keeps virtual prototypes when d=%s deletes physical placements',
    async (selector) => {
      const h = createPlaceholderTerminal()
      try {
        await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
        await write(h.terminal, placeholderCells(7))
        await writeKitty(h.terminal, `a=d,d=${selector},q=2`)
        expect(render(h)).toHaveLength(2)
        expect(h.kitty.getImage(7)).toBeDefined()
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it('deletes a named prototype without deleting another placement of the image', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=11,c=1,r=1')
      await write(h.terminal, `${placeholderCells(7, 10)}\r\n${placeholderCells(7, 11, 1, 1)}`)
      await writeKitty(h.terminal, 'a=d,d=I,i=7,p=10,q=2')
      expect(render(h)).toHaveLength(1)
      expect(h.bitmaps[0].close).toHaveBeenCalledOnce()
      expect(h.bitmaps[1].close).not.toHaveBeenCalled()
      expect(h.kitty.getImage(7)).toBeDefined()
    } finally {
      h.terminal.dispose()
    }
  })

  it('retains image data after deleting placements so a=p can restore a prototype', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=d,d=i,i=7,q=2')
      expect(h.kitty.getImage(7)).toBeDefined()
      await writeKitty(h.terminal, 'a=p,U=1,i=7,c=2,r=2')
      await write(h.terminal, placeholderCells(7))
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it('inherits omitted diacritics only across consecutive matching cells', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, `\x1b[38;5;7m${PLACEHOLDER}${DIACRITICS[1]}${PLACEHOLDER}`)
      expect(render(h)).toHaveLength(1)
      expect(h.drawImage.mock.calls[0].slice(1, 5)).toEqual([0, 5, 20, 5])
      await write(h.terminal, ` ${PLACEHOLDER}`)
      const calls = render(h)
      expect(calls).toHaveLength(2)
      expect(calls[1].slice(1, 5)).toEqual([0, 0, 10, 5])
    } finally {
      h.terminal.dispose()
    }
  })

  it('ignores invalid row diacritics rather than treating them as omitted', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, `\x1b[38;5;7m${PLACEHOLDER}\u0301${DIACRITICS[0]}`)
      expect(render(h)).toHaveLength(0)
    } finally {
      h.terminal.dispose()
    }
  })

  it('preserves the source aspect ratio when cell proportions change', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      const createCanvas = vi.fn(() => ({ getContext: () => ({ drawImage: vi.fn() }) }))
      vi.stubGlobal('document', { createElement: createCanvas })
      vi.spyOn(h.renderer, 'cellSize', 'get').mockReturnValue({ width: 5, height: 10 })
      const calls = render(h)
      expect(calls[0].slice(1)).toEqual([0, 0, 20, 5, 0, 7.5, 10, 2.5])
      expect(calls[1].slice(1)).toEqual([0, 5, 20, 5, 0, 10, 10, 2.5])
      expect(h.storage.getUsage()).toBe(0.0008)
      expect(createCanvas).not.toHaveBeenCalled()
    } finally {
      h.terminal.dispose()
    }
  })

  it('follows placeholder cells through scrollback and erasure', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      await write(h.terminal, '\r\n'.repeat(6))
      expect(render(h)).toHaveLength(0)
      h.terminal.scrollToTop()
      expect(render(h)).toHaveLength(2)
      h.terminal.scrollToBottom()
      await write(h.terminal, '\x1b[3J')
      h.terminal.scrollToTop()
      expect(render(h)).toHaveLength(0)
    } finally {
      h.terminal.dispose()
    }
  })
})
