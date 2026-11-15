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

async function prepared() {
  const h = createPlaceholderTerminal()
  await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
  await write(h.terminal, placeholderCells(7, 10))
  const first = h.bitmaps[0]
  const pending = []
  vi.stubGlobal(
    'createImageBitmap',
    () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  )
  return { h, first, pending }
}

describe('placeholder replacement publication boundaries', () => {
  it('keeps the existing picture until its replacement finishes decoding', async () => {
    const { h, first, pending } = await prepared()
    const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      expect(render(h).map((call) => call[0])).toEqual([first, first])
      expect(first.close).not.toHaveBeenCalled()
    } finally {
      pending[0]?.resolve(new TrackedBitmap())
      await writing
      h.terminal.dispose()
    }
  })

  it('publishes no stale replacement after an addon reset during decoding', async () => {
    const { h, first, pending } = await prepared()
    const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
    const replacement = new TrackedBitmap()
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      h.addon.reset()
      pending[0].resolve(replacement)
      await writing
      expect(render(h)).toHaveLength(0)
      expect(h.kitty._virtualPlacements.size).toBe(0)
      expect(h.storage._images.size).toBe(0)
      expect(first.close).toHaveBeenCalledOnce()
      expect(replacement.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('drops stale pictures and closes the replacement when storage rejects publication', async () => {
    const { h, first, pending } = await prepared()
    const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
    const replacement = new TrackedBitmap()
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      vi.spyOn(h.storage, 'addUnplacedImage').mockImplementationOnce(() => {
        throw new Error('publication failed')
      })
      pending[0].resolve(replacement)
      await writing
      expect(render(h)).toHaveLength(0)
      expect(first.close).toHaveBeenCalledOnce()
      expect(replacement.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })
})
