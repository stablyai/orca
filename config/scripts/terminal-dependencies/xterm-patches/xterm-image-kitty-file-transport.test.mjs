import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  PNG,
  placeholderCells,
  render,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

const pathPayload = Buffer.from('/tmp/claude-image.png').toString('base64')
const pngBytes = Uint8Array.from(Buffer.from(PNG, 'base64'))
afterEach(() => vi.unstubAllGlobals())

function withReader(reader) {
  const h = createPlaceholderTerminal()
  h.addon._opts.readKittyFile = reader
  h.responses = []
  h.terminal.onData((data) => h.responses.push(data))
  return h
}

describe('Kitty file transport through the installed addon', () => {
  it('passes exact O/S windows and keeps parser order across asynchronous reads', async () => {
    let resolve
    const reader = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const h = withReader(reader)
    try {
      const pending = write(
        h.terminal,
        `\x1b_Ga=T,t=f,f=100,i=7,U=1,c=2,r=2,O=13,S=${pngBytes.length};${pathPayload}\x1b\\AFTER`
      )
      await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce())
      expect(reader.mock.calls[0][0]).toMatchObject({
        path: '/tmp/claude-image.png',
        offset: 13,
        length: pngBytes.length
      })
      expect(h.terminal.buffer.active.getLine(0).translateToString()).not.toContain('AFTER')
      resolve(pngBytes)
      await pending
      expect(h.terminal.buffer.active.getLine(0).translateToString()).toContain('AFTER')
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['reject', 'wrong-length', 'oversize'])(
    'preserves an existing placement on %s',
    async (failure) => {
      const reader = vi.fn(async () => {
        if (failure === 'reject') {
          throw new Error('private-host-path')
        }
        return failure === 'oversize' ? new Uint8Array(8 * 1024 * 1024 + 1) : pngBytes
      })
      const h = withReader(reader)
      try {
        await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
        await write(h.terminal, placeholderCells(7))
        const old = h.bitmaps[0]
        await writeKitty(
          h.terminal,
          `a=T,t=f,f=100,i=7,U=1,c=2,r=2${failure === 'wrong-length' ? ',S=1' : ''}`,
          pathPayload
        )
        expect(render(h)[0][0]).toBe(old)
        expect(old.close).not.toHaveBeenCalled()
        expect(h.responses.join('')).toContain('EINVAL')
        expect(h.responses.join('')).not.toContain('private-host-path')
      } finally {
        h.terminal.dispose()
      }
    }
  )

  it.each(['reset', 'dispose'])(
    'aborts a pending host read on addon %s and drops late results',
    async (action) => {
      let request
      let resolve
      const h = withReader((value) => {
        request = value
        return new Promise((done) => {
          resolve = done
        })
      })
      const pending = writeKitty(h.terminal, 'a=T,t=f,f=100,i=7,U=1,c=2,r=2', pathPayload)
      await vi.waitFor(() => expect(request).toBeDefined())
      h.addon[action]()
      expect(request.signal.aborted).toBe(true)
      resolve(pngBytes)
      await pending
      expect(h.decode).not.toHaveBeenCalled()
      expect(h.responses).toEqual([])
      h.terminal.dispose()
    }
  )
})
