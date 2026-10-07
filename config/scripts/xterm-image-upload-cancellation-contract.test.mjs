import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from([255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255])
const raw = rgba.toString('base64')
const image = new PNG({ width: 2, height: 2 })
image.data.set(rgba)
const png = PNG.sync.write(image).toString('base64')
const write = (h, sequence) => h.core._core.writeSync(sequence)
const kitty = (command, payload = '') => `\x1b_G${command};${payload}\x1b\\`
const osc = (payload) => `\x1b]1337;${payload}\x07`
const multipart = 'MultipartFile=inline=1;width=2px;height=2px'

function completeMultipart(h) {
  write(h, osc(multipart))
  write(h, osc(`FilePart=${png}`))
  write(h, osc('FileEnd'))
  expect(h.storage._images.size).toBe(1)
  expect([...h.storage._images.values()][0].orig.data).toEqual(new Uint8ClampedArray(rgba))
}

describe('unfinished image upload cancellation', () => {
  it.each(['kitty', 'iip'])('ignores the active %s payload after an addon reset', (protocol) => {
    const h = terminal()
    try {
      const start =
        protocol === 'kitty'
          ? `\x1b_Ga=T,f=32,s=2,v=2,i=7,q=2;${raw.slice(0, 4)}`
          : `\x1b]1337;File=inline=1;width=2px;height=2px:${png.slice(0, 4)}`
      const continuation = protocol === 'kitty' ? `${raw}\x1b\\` : `${png}\x07`
      write(h, start)
      h.addon.reset()
      expect(h.addon._handlers.get(protocol)._aborted).toBe(true)
      expect(() => write(h, continuation)).not.toThrow()
      expect(h.storage._images.size).toBe(0)
      completeMultipart(h)
    } finally {
      h.core.dispose()
    }
  })

  it('preserves a Kitty upload when a canceled continuation has not fed its decoder', () => {
    const h = terminal()
    const handler = h.addon._handlers.get('kitty')
    try {
      write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1,q=2', raw.slice(0, 4)))
      const pending = handler._pendingTransmissions.get(7)
      write(h, '\x1b_Gi=7,m=1,q=2;\x18')
      expect(handler._pendingTransmissions.get(7)).toBe(pending)
      write(h, kitty('m=0,q=2', raw.slice(4)))
      expect(h.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      h.core.dispose()
    }
  })

  it('drops a canceled IIP FileEnd instead of displaying its complete payload', () => {
    const h = terminal()
    try {
      write(h, osc(multipart))
      write(h, osc(`FilePart=${png}`))
      write(h, '\x1b]1337;FileEnd\x18')
      write(h, osc('FileEnd'))
      expect(h.storage._images.size).toBe(0)
      completeMultipart(h)
    } finally {
      h.core.dispose()
    }
  })

  it.each(['\x18', '\x1a'])('removes only the Kitty upload canceled by %j', (cancel) => {
    const h = terminal()
    const handler = h.addon._handlers.get('kitty')
    try {
      write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1,q=2', raw.slice(0, 4)))
      write(h, kitty('a=t,f=32,s=2,v=2,i=9,m=1,q=2', raw.slice(0, 4)))
      const canceled = handler._pendingTransmissions.get(7).decoder
      const release = vi.spyOn(canceled, 'release')
      write(h, `\x1b_Gi=7,m=1,q=2;${raw.slice(4, 8)}${cancel}`)
      expect(release).toHaveBeenCalledTimes(1)
      expect(handler._pendingTransmissions.has(7)).toBe(false)
      expect(handler._pendingTransmissions.has(9)).toBe(true)
      expect(handler._lastPendingKey).toBe(9)
      expect(handler._activeDecoder).toBeNull()
      write(h, kitty('m=0,q=2', raw.slice(4)))
      expect(h.kittyStorage.getImage(9).data).toEqual(new Uint8Array(rgba))
      write(h, kitty('a=t,f=32,s=2,v=2,i=7,q=2', raw))
      expect(h.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      h.core.dispose()
    }
  })

  it('clears the implicit Kitty continuation key when its decoder is canceled', () => {
    const h = terminal()
    const handler = h.addon._handlers.get('kitty')
    try {
      write(h, kitty('a=t,f=32,s=2,v=2,i=7,m=1,q=2', raw.slice(0, 4)))
      write(h, `\x1b_Gm=1,q=2;${raw.slice(4, 8)}\x18`)
      expect(handler._pendingTransmissions.size).toBe(0)
      expect(handler._lastPendingKey).toBeUndefined()
      write(h, kitty('a=t,f=32,s=2,v=2,i=7,q=2', raw))
      expect(h.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      h.core.dispose()
    }
  })

  it.each(['\x18', '\x1a'])(
    'drops an IIP multipart upload after a FilePart canceled by %j',
    (cancel) => {
      const h = terminal()
      const handler = h.addon._handlers.get('iip')
      try {
        write(h, osc(multipart))
        write(h, osc(`FilePart=${png.slice(0, 4)}`))
        write(h, `\x1b]1337;FilePart=${png.slice(4, 8)}${cancel}`)
        write(h, osc(`FilePart=${png.slice(8)}`))
        write(h, osc('FileEnd'))
        expect(h.storage._images.size).toBe(0)
        expect(handler._dec._inst).toBeNull()
        completeMultipart(h)
      } finally {
        h.core.dispose()
      }
    }
  )

  it('does not allocate an IIP decoder for a canceled multipart header', () => {
    const h = terminal()
    const handler = h.addon._handlers.get('iip')
    try {
      write(h, `\x1b]1337;${multipart}\x18`)
      expect(handler._dec._inst).toBeNull()
      expect(handler._isMultipart).toBe(false)
      completeMultipart(h)
    } finally {
      h.core.dispose()
    }
  })

  it('silences a canceled cell-size report without damaging an IIP multipart upload', () => {
    const h = terminal()
    const replies = vi.fn()
    h.core.onData(replies)
    try {
      write(h, osc(multipart))
      write(h, osc(`FilePart=${png.slice(0, 8)}`))
      write(h, '\x1b]1337;ReportCellSize\x18')
      expect(replies).not.toHaveBeenCalled()
      write(h, osc(`FilePart=${png.slice(8)}`))
      write(h, osc('FileEnd'))
      expect(h.storage._images.size).toBe(1)
    } finally {
      h.core.dispose()
    }
  })

  it.each(['\x1bc', 'addon reset'])('clears IIP multipart ownership on %j', (reset) => {
    const h = terminal()
    const handler = h.addon._handlers.get('iip')
    try {
      write(h, osc(multipart))
      write(h, osc(`FilePart=${png.slice(0, 8)}`))
      if (reset === 'addon reset') {
        h.addon.reset()
      } else {
        write(h, reset)
      }
      expect(handler._isMultipart).toBe(false)
      expect(handler._abortMulti).toBe(false)
      expect(handler._dec._inst).toBeNull()
      completeMultipart(h)
    } finally {
      h.core.dispose()
    }
  })

  it.each(['header and payload together', 'payload in a later write'])(
    'invalidates an IIP multipart upload after Base64 failure with %s',
    (boundary) => {
      const h = terminal()
      const handler = h.addon._handlers.get('iip')
      try {
        write(h, osc(multipart))
        if (boundary === 'payload in a later write') {
          write(h, '\x1b]1337;FilePart=')
        }
        write(
          h,
          `${boundary === 'header and payload together' ? '\x1b]1337;FilePart=' : ''}${'!'.repeat(131072)}\x07`
        )
        expect(handler._abortMulti).toBe(true)
        expect(handler._dec._inst).toBeNull()
        expect(() => write(h, osc(`FilePart=${png}`))).not.toThrow()
        write(h, osc('FileEnd'))
        expect(h.storage._images.size).toBe(0)
        completeMultipart(h)
      } finally {
        h.core.dispose()
      }
    }
  )
})
