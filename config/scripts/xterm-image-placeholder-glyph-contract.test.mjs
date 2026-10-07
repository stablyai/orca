import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  DIACRITICS,
  placeholderCells,
  PLACEHOLDER,
  PNG,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('Kitty placeholder glyph suppression', () => {
  it('hides mapped cells without modifying their text or attributes', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, `ordinary ${placeholderCells(7)}`)
      const line = h.terminal.buffer.active.getLine(0)
      const before = line.translateToString()
      const fg = line.getCell(9).getFgColor()
      expect([...h.storage.getHiddenGlyphColumns(0)]).toEqual([9, 10])
      expect([...h.storage.getHiddenGlyphColumns(1)]).toEqual([0, 1])
      expect(line.translateToString()).toBe(before)
      expect(line.getCell(9).getFgColor()).toBe(fg)
    } finally {
      h.terminal.dispose()
    }
  })

  it('clips suppression to the placement grid and resolves named high-byte IDs', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=2147483655,U=1,p=11,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(0x80000007, 11, 3, 3))
      expect([...h.storage.getHiddenGlyphColumns(0)]).toEqual([0, 1])
      expect([...h.storage.getHiddenGlyphColumns(1)]).toEqual([0, 1])
      expect(h.storage.getHiddenGlyphColumns(2)).toBeUndefined()
    } finally {
      h.terminal.dispose()
    }
  })

  it('inherits omitted coordinates only through consecutive matching cells', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(
        h.terminal,
        `\x1b[38;2;0;0;7m${PLACEHOLDER}${DIACRITICS[1]}${DIACRITICS[0]}${PLACEHOLDER}X${PLACEHOLDER}`
      )
      expect([...h.storage.getHiddenGlyphColumns(0)]).toEqual([0, 1, 3])
    } finally {
      h.terminal.dispose()
    }
  })

  it('leaves unmatched text visible and clears suppression after placement deletion', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=11,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7, 10))
      expect(h.storage.getHiddenGlyphColumns(0)).toBeUndefined()
      await write(h.terminal, `\x1b[1;1H${placeholderCells(7, 11)}`)
      expect([...h.storage.getHiddenGlyphColumns(0)]).toEqual([0, 1])
      await writeKitty(h.terminal, 'a=d,d=I,i=7,p=11,q=2')
      expect(h.storage.getHiddenGlyphColumns(0)).toBeUndefined()
      expect(h.terminal.buffer.active.getLine(0).getCell(0).getChars()).toContain(PLACEHOLDER)
    } finally {
      h.terminal.dispose()
    }
  })

  it('provides glyph suppression to a DOM renderer without enabling negative layers', () => {
    const h = createPlaceholderTerminal()
    try {
      const renderer = { setImageLayerProvider: vi.fn() }
      h.renderer._bindRenderer(renderer)
      const provider = renderer.setImageLayerProvider.mock.calls.at(-1)[0]
      expect(provider).toBeDefined()
      expect(provider.hasNegativeImages()).toBe(false)
      expect(provider.getHiddenGlyphColumns(0)).toBeUndefined()
      h.renderer.dispose()
      expect(renderer.setImageLayerProvider).toHaveBeenLastCalledWith(undefined)
    } finally {
      h.terminal.dispose()
    }
  })
})
