import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  PLACEHOLDER,
  placeholderCells,
  PNG,
  render,
  TrackedBitmap,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

const marks = {
  0: '\u{305}',
  1: '\u{30d}',
  128: '\u{82d}',
  255: '\u{a8e5}',
  256: '\u{a8e6}',
  283: '\u{10a0f}'
}

function colors(id, placement = 0) {
  const low = id & 0xffffff
  return (
    `\x1b[38;2;${low >>> 16};${(low >>> 8) & 255};${low & 255}m` +
    `\x1b[58;2;${placement >>> 16};${(placement >>> 8) & 255};${placement & 255}m`
  )
}

function placeholderAt(id, placement, row, col) {
  return colors(id, placement) + PLACEHOLDER + marks[row] + marks[col] + marks[id >>> 24]
}

describe('placeholder coordinate and ID boundaries through real parsing', () => {
  it('resolves maximum high-byte image ID as unsigned', async () => {
    const id = 0xff000007
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, `a=T,f=100,i=${id},U=1,c=2,r=2`, PNG)
      await write(h.terminal, placeholderAt(id, 0, 0, 0))
      expect(render(h)).toHaveLength(1)
    } finally {
      h.terminal.dispose()
    }
  })

  it('decodes a non-BMP row/column index without UTF-16 splitting', async () => {
    const index = 283
    const h = createPlaceholderTerminal()
    try {
      h.addon._handlers.get('kitty')._createBitmap = async () => {
        const bitmap = new TrackedBitmap(297, 297)
        h.bitmaps.push(bitmap)
        return bitmap
      }
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=297,r=297', PNG)
      await write(h.terminal, placeholderAt(7, 0, index, index))
      const calls = render(h)
      expect(calls).toHaveLength(1)
      expect(calls[0].slice(1)).toEqual([index, index, 1, 1, 0, 0, 10, 10])
      expect(h.terminal.buffer.active.cursorX).toBe(1)
    } finally {
      h.terminal.dispose()
    }
  })

  it('rejects table index 256 in the high-byte position', async () => {
    const index = 256
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, colors(7) + PLACEHOLDER + marks[0] + marks[0] + marks[index])
      expect(render(h)).toHaveLength(0)
    } finally {
      h.terminal.dispose()
    }
  })

  it('starts a new omitted-coordinate run when the low image ID changes', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=T,f=100,i=9,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderAt(7, 0, 1, 0) + colors(9) + PLACEHOLDER)
      const calls = render(h)
      expect(calls).toHaveLength(2)
      expect(calls[0][0]).toBe(h.bitmaps[0])
      expect(calls[0].slice(1, 5)).toEqual([0, 5, 10, 5])
      expect(calls[1][0]).toBe(h.bitmaps[1])
      expect(calls[1].slice(1, 5)).toEqual([0, 0, 10, 5])
    } finally {
      h.terminal.dispose()
    }
  })

  it('starts a new omitted-coordinate run when the placement ID changes', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=11,c=2,r=2')
      await write(h.terminal, placeholderAt(7, 10, 1, 0) + colors(7, 11) + PLACEHOLDER)
      const calls = render(h)
      expect(calls).toHaveLength(2)
      expect(calls[0][0]).toBe(h.bitmaps[0])
      expect(calls[0].slice(1, 5)).toEqual([0, 5, 10, 5])
      expect(calls[1][0]).toBe(h.bitmaps[1])
      expect(calls[1].slice(1, 5)).toEqual([0, 0, 10, 5])
    } finally {
      h.terminal.dispose()
    }
  })

  it('does not inherit a high byte across ordinary text', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=2147483655,U=1,c=2,r=2', PNG)
      await write(h.terminal, `${placeholderAt(0x80000007, 0, 0, 0)} ${PLACEHOLDER}`)
      const calls = render(h)
      expect(calls).toHaveLength(1)
      expect(calls[0].slice(1, 5)).toEqual([0, 0, 10, 5])
    } finally {
      h.terminal.dispose()
    }
  })
})

async function prepared() {
  const h = createPlaceholderTerminal()
  await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=0,c=1,r=1', PNG)
  await writeKitty(h.terminal, 'a=p,U=1,i=7,p=10,c=1,r=1')
  await write(h.terminal, placeholderCells(7, 10, 1, 1))
  return h
}

async function overwriteUnnamed(h) {
  await write(h.terminal, `\x1b[0m\x1b[H\x1b[38;2;0;0;7m${PLACEHOLDER}\u0305\u0305`)
  return render(h)
}

describe('placeholder placement IDs after overwriting old extended attributes', () => {
  it('keeps default image pixels after the old named prototype is deleted', async () => {
    const h = await prepared()
    try {
      await writeKitty(h.terminal, 'a=d,d=I,i=7,p=10,q=2')
      const calls = await overwriteUnnamed(h)
      expect(calls).toHaveLength(1)
      expect(calls[0][0]).toBe(h.bitmaps[0])
    } finally {
      h.terminal.dispose()
    }
  })
})
