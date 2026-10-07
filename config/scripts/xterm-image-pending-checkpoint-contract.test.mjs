import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from(Array.from({ length: 200 * 200 }, (_, i) => [i % 256, 100, 0, 255]).flat())
const encoded = rgba.toString('base64')
const pixels = new PNG({ width: 200, height: 200 })
pixels.data.set(rgba)
const png = PNG.sync.write(pixels, { deflateLevel: 0 }).toString('base64')
const write = (h, value) => h.core._core.writeSync(value)
const kitty = (command, payload = '') => `\x1b_G${command};${payload}\x1b\\`
const osc = (value) => `\x1b]1337;${value}\x07`
const header = 'MultipartFile=inline=1;width=200px;height=200px;preserveAspectRatio=0'
const handler = (h, protocol) => h.addon._handlers.get(protocol)

function roundTrip(source, target, protocol, replay = '') {
  const checkpoint = handler(source, protocol).capturePendingCheckpoint(1024 * 1024)
  try {
    source.core.dispose()
    handler(target, protocol).restorePendingCheckpoint(checkpoint)
    write(target, replay)
    return checkpoint
  } catch (error) {
    checkpoint.dispose()
    throw error
  }
}

describe('pending inline image upload checkpoint component', () => {
  it.each([1, 2, 3, 4, 131067, 131068, 131069, 131070, 131071])(
    'restores a Kitty chunk boundary at %i Base64 bytes without retransmitting its prefix',
    (cut) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, kitty('a=t,f=32,s=200,v=200,i=7,m=1,q=2', encoded.slice(0, cut)))
        checkpoint = roundTrip(source, target, 'kitty')
        write(target, kitty('m=0,q=2', encoded.slice(cut)))
        expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
        expect(handler(target, 'kitty')._pendingTransmissions.size).toBe(0)
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each([1, 2, 3, 131069])(
    'excludes active Kitty escape bytes after a completed prefix of %i',
    (cut) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, kitty('a=t,f=32,s=200,v=200,i=7,m=1,q=2', encoded.slice(0, cut)))
        const replay = `\x1b_Gm=1,q=2;${encoded.slice(cut, -4)}`
        write(source, replay)
        expect(
          handler(source, 'kitty')._pendingTransmissions.get(7).decoder.data8.length
        ).toBeGreaterThan(100000)
        checkpoint = roundTrip(source, target, 'kitty', replay)
        write(target, `${encoded.slice(-4)}\x1b\\${kitty('m=0,q=2')}`)
        expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('preserves interleaved Kitty uploads, the implicit continuation key and retained sources', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, kitty('a=t,f=32,s=200,v=200,i=7,m=1,q=2', encoded.slice(0, 3)))
      write(source, kitty('a=t,f=32,s=200,v=200,i=2147483655,m=1,q=2', encoded.slice(0, 2)))
      write(target, kitty('a=t,f=32,s=200,v=200,i=19,q=2', encoded))
      const existing = target.kittyStorage.getImage(19)
      checkpoint = roundTrip(source, target, 'kitty')
      expect([...handler(target, 'kitty')._pendingTransmissions.keys()]).toEqual([7, 2147483655])
      write(target, kitty('m=0,q=2', encoded.slice(2)))
      write(target, kitty('i=7,m=0,q=2', encoded.slice(3)))
      expect(target.kittyStorage.getImage(2147483655).data).toEqual(new Uint8Array(rgba))
      expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
      expect(target.kittyStorage.getImage(19)).toBe(existing)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([1, 2, 3])('restores an IIP multipart boundary with %i carry bytes', (cut) => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, osc(header) + osc(`FilePart=${png.slice(0, cut)}`))
      checkpoint = roundTrip(source, target, 'iip')
      write(target, osc(`FilePart=${png.slice(cut)}`) + osc('FileEnd'))
      expect([...target.storage._images.values()][0].orig.data).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('excludes the active IIP FilePart from the persistent multipart prefix', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, osc(header) + osc(`FilePart=${png.slice(0, 3)}`))
      const replay = `\x1b]1337;FilePart=${png.slice(3, -4)}`
      write(source, replay)
      expect(handler(source, 'iip')._dec.data8.length).toBeGreaterThan(100000)
      checkpoint = roundTrip(source, target, 'iip', replay)
      write(target, `${png.slice(-4)}\x07${osc('FileEnd')}`)
      expect([...target.storage._images.values()][0].orig.data).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('preserves an aborted IIP multipart transfer without a decoder resource', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `${osc(header)}\x1b]1337;FilePart=${png.slice(0, 4)}\x18`)
      checkpoint = roundTrip(source, target, 'iip')
      expect(checkpoint.metadata.resources).toEqual([])
      write(target, osc(`FilePart=${png}`) + osc('FileEnd'))
      expect(target.storage._images.size).toBe(0)
      write(target, osc(header) + osc(`FilePart=${png}`) + osc('FileEnd'))
      expect(target.storage._images.size).toBe(1)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['kitty', 'iip'])(
    'owns immutable %s resources and enforces capture/lease limits',
    (protocol) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(
          source,
          protocol === 'kitty'
            ? kitty('a=t,f=32,s=200,v=200,i=7,m=1,q=2', encoded.slice(0, 3))
            : osc(header) + osc(`FilePart=${png.slice(0, 3)}`)
        )
        expect(() => handler(source, protocol).capturePendingCheckpoint(2)).toThrow(/budget/i)
        checkpoint = handler(source, protocol).capturePendingCheckpoint(1024)
        const resource = checkpoint.metadata.resources[0]
        expect(Object.isFrozen(checkpoint.metadata)).toBe(true)
        checkpoint.readResource(resource.id, 0, resource.byteLength).fill(0)
        source.addon.reset()
        handler(target, protocol).restorePendingCheckpoint(checkpoint)
        checkpoint.dispose()
        expect(() => handler(target, protocol).restorePendingCheckpoint(checkpoint)).toThrow(
          /disposed/i
        )
        write(
          target,
          protocol === 'kitty'
            ? kitty('m=0,q=2', encoded.slice(3))
            : osc(`FilePart=${png.slice(3)}`) + osc('FileEnd')
        )
        expect(
          protocol === 'kitty'
            ? target.kittyStorage.getImage(7).data.byteLength
            : target.storage._images.size
        ).toBe(protocol === 'kitty' ? rgba.length : 1)
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['payload limit', 'decoder capacity', 'allocation failure'])(
    'keeps existing Kitty upload ownership on %s',
    (reason) => {
      const source = terminal()
      const target = terminal(
        false,
        reason === 'payload limit'
          ? { kittySizeLimit: 4 }
          : reason === 'decoder capacity'
            ? { storageLimit: 12 }
            : {}
      )
      let checkpoint
      try {
        write(source, kitty('a=t,f=32,s=200,v=200,i=7,m=1,q=2', encoded.slice(0, 8)))
        write(source, kitty('a=t,f=32,s=200,v=200,i=8,m=1,q=2', encoded.slice(0, 8)))
        write(target, kitty('a=t,f=32,s=1,v=1,i=9,m=1,q=2', encoded.slice(0, 1)))
        const previous = handler(target, 'kitty')._pendingTransmissions.get(9)
        checkpoint = handler(source, 'kitty').capturePendingCheckpoint(1024)
        const Memory = WebAssembly.Memory
        let allocations = 0
        if (reason === 'allocation failure') {
          vi.spyOn(WebAssembly, 'Memory').mockImplementation(function (options) {
            if (++allocations === 2) {
              throw new RangeError('Preparation allocation failed')
            }
            return new Memory(options)
          })
        }
        expect(() => handler(target, 'kitty').restorePendingCheckpoint(checkpoint)).toThrow()
        vi.restoreAllMocks()
        expect(handler(target, 'kitty')._pendingTransmissions.get(9)).toBe(previous)
        expect(handler(target, 'kitty')._pendingTransmissions.size).toBe(1)
        expect(previous.decoder.loadedBytes).toBe(1)
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )
})
