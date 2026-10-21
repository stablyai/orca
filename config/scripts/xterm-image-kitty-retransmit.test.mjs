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

  it('does not delete another picture when the replacement fails decoding', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=T,f=100,i=9,U=1,p=11,c=2,r=2', PNG)
      const unrelated = [...h.kitty._virtualPlacements.get(9).values()][0]
      vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('decode failure')))
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      expect(h.kitty._virtualPlacements.has(7)).toBe(false)
      expect(h.kitty._virtualPlacements.get(9).get(11)).toBe(unrelated)
      expect(h.bitmaps[1].close).not.toHaveBeenCalled()
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

  it('retains every old placement until success, then leaves only the replacement placement ID', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=11,c=1,r=1')
      const old = [...h.bitmaps]
      let resolve
      vi.stubGlobal(
        'createImageBitmap',
        () =>
          new Promise((finish) => {
            resolve = finish
          })
      )
      const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=12,c=2,r=2', PNG)
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
      const during = [...(h.kitty._virtualPlacements.get(7)?.keys() ?? [])]
      const replacement = new TrackedBitmap()
      resolve(replacement)
      await writing
      expect(during).toEqual([10, 11])
      expect([...h.kitty._virtualPlacements.get(7).keys()]).toEqual([12])
      expect(h.storage._images.size).toBe(1)
      for (const bitmap of old) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
      expect(replacement.close).not.toHaveBeenCalled()
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['resolve', 'reject'])(
    'an unrelated query does not cancel a replacement decode that will %s',
    async (completion) => {
      const { h, first, pending } = await prepared()
      const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      const stale = new TrackedBitmap()
      try {
        await vi.waitFor(() => expect(pending).toHaveLength(1))
        const handler = h.addon._handlers.get('kitty')
        const command = Uint32Array.from('a=q,i=9;'.split('').map((char) => char.codePointAt(0)))
        handler.start()
        handler.put(command, 0, command.length)
        await handler.end(true)
        if (completion === 'resolve') {
          pending[0].resolve(stale)
        } else {
          pending[0].reject(new Error('late decode failure'))
        }
        await writing
        expect(render(h).map((call) => call[0])).toEqual(
          completion === 'resolve' ? [stale, stale] : []
        )
        expect(first.close).toHaveBeenCalledOnce()
        expect(stale.close.mock.calls.length).toBe(0)
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it('cannot resurrect a deleted placement after a newer delete supersedes the decode', async () => {
    const { h, first, pending } = await prepared()
    const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
    const stale = new TrackedBitmap()
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      const handler = h.addon._handlers.get('kitty')
      const command = Uint32Array.from(
        'a=d,d=I,i=7,p=10;'.split('').map((char) => char.codePointAt(0))
      )
      handler.start()
      handler.put(command, 0, command.length)
      await handler.end(true)
      pending[0].resolve(stale)
      await writing
      expect(h.kitty._virtualPlacements.size).toBe(0)
      expect(h.storage._images.size).toBe(0)
      expect(first.close).toHaveBeenCalledOnce()
      expect(stale.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['resolve', 'reject'])(
    'a newer same-image source preserves the old picture after its superseded decode will %s',
    async (completion) => {
      const { h, first, pending } = await prepared()
      const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      const stale = new TrackedBitmap()
      const latest = new TrackedBitmap()
      try {
        await vi.waitFor(() => expect(pending).toHaveLength(1))
        const handler = h.addon._handlers.get('kitty')
        const command = Uint32Array.from(
          `a=T,f=100,i=7,U=1,p=10,c=2,r=2;${PNG}`.split('').map((char) => char.codePointAt(0))
        )
        handler.start()
        handler.put(command, 0, command.length)
        const newer = handler.end(true)
        await vi.waitFor(() => expect(pending).toHaveLength(2))
        if (completion === 'resolve') {
          pending[0].resolve(stale)
        } else {
          pending[0].reject(new Error('late decode failure'))
        }
        await writing
        expect(render(h).map((call) => call[0])).toEqual([first, first])
        expect(first.close).not.toHaveBeenCalled()
        expect(stale.close.mock.calls.length).toBe(completion === 'resolve' ? 1 : 0)
        pending[1].resolve(latest)
        await newer
        expect(render(h).map((call) => call[0])).toEqual([latest, latest])
        expect(first.close).toHaveBeenCalledOnce()
        expect(latest.close).not.toHaveBeenCalled()
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it('does not publish after disposal while decode is pending', async () => {
    const { h, first, pending } = await prepared()
    const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
    const stale = new TrackedBitmap()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    h.addon.dispose()
    pending[0].resolve(stale)
    await writing
    expect(h.storage._images.size).toBe(0)
    expect(h.kitty._virtualPlacements.size).toBe(0)
    expect(first.close).toHaveBeenCalledOnce()
    expect(stale.close).toHaveBeenCalledOnce()
    h.terminal.dispose()
  })
})
