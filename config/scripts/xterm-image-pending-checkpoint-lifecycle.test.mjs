import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from([255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255, 255, 100, 0, 255])
const encoded = rgba.toString('base64')
const pixels = new PNG({ width: 2, height: 2 })
pixels.data.set(rgba)
const png = PNG.sync.write(pixels).toString('base64')
const write = (h, value) => h.core._core.writeSync(value)
const kitty = (command, payload = '') => `\x1b_G${command};${payload}\x1b\\`
const osc = (value) => `\x1b]1337;${value}\x07`
const header = 'MultipartFile=inline=1;width=2px;height=2px;preserveAspectRatio=0'
const handler = (h, protocol) => h.addon._handlers.get(protocol)
function start(h, protocol, id = 7) {
  write(
    h,
    protocol === 'kitty'
      ? kitty(`a=t,f=32,s=2,v=2,i=${id},m=1,q=2`, encoded.slice(0, 3))
      : osc(header) + osc(`FilePart=${png.slice(0, 3)}`)
  )
}
function finish(h, protocol) {
  write(
    h,
    protocol === 'kitty'
      ? kitty('m=0,q=2', encoded.slice(3))
      : osc(`FilePart=${png.slice(3)}`) + osc('FileEnd')
  )
  expect(
    protocol === 'kitty'
      ? handler(h, 'kitty')._kittyStorage.getImage(7).data
      : [...h.storage._images.values()][0].orig.data
  ).toEqual(protocol === 'kitty' ? new Uint8Array(rgba) : new Uint8ClampedArray(rgba))
}

describe('pending image checkpoint lifecycle and preparation', () => {
  it('retains automatic Kitty ID assignment for an upload whose first chunk omitted i', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, kitty('a=t,f=32,s=2,v=2,m=1,q=2', encoded.slice(0, 3)))
      checkpoint = handler(source, 'kitty').capturePendingCheckpoint(1024)
      expect(checkpoint.metadata.lastPendingKey).toBe(0)
      handler(target, 'kitty').restorePendingCheckpoint(checkpoint)
      write(target, kitty('m=0,q=2', encoded.slice(3)))
      expect(target.kittyStorage.lastImageId).toBe(1)
      expect(target.kittyStorage.getImage(1).data).toEqual(new Uint8Array(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['counter mismatch', 'truncated resource', 'unknown resource'])(
    'rejects a malformed Kitty %s before replacing a live upload',
    (reason) => {
      const source = terminal(),
        target = terminal()
      let checkpoint, malformed
      try {
        start(source, 'kitty')
        start(target, 'kitty', 9)
        const previous = handler(target, 'kitty')._pendingTransmissions.get(9)
        checkpoint = handler(source, 'kitty').capturePendingCheckpoint(1024)
        const entry = checkpoint.metadata.pending[0]
        const resource = checkpoint.readResource(entry.resourceId, 0, entry.byteLength)
        malformed = new checkpoint.constructor(
          {
            ...checkpoint.metadata,
            pending: [
              {
                ...entry,
                encodedByteLength:
                  entry.encodedByteLength + (reason === 'counter mismatch' ? 1 : 0),
                resourceId: reason === 'unknown resource' ? 99 : entry.resourceId
              }
            ]
          },
          new Map([
            [entry.resourceId, reason === 'truncated resource' ? resource.subarray(1) : resource]
          ])
        )
        const memory = vi.spyOn(WebAssembly, 'Memory')
        expect(() => handler(target, 'kitty').restorePendingCheckpoint(malformed)).toThrow()
        expect(memory).not.toHaveBeenCalled()
        expect(handler(target, 'kitty')._pendingTransmissions.get(9)).toBe(previous)
      } finally {
        vi.restoreAllMocks()
        malformed?.dispose()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('copies IIP header fields independently of later source mutation', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source, 'iip')
      checkpoint = handler(source, 'iip').capturePendingCheckpoint(1024)
      expect(Object.isFrozen(checkpoint.metadata.multipart.header)).toBe(true)
      handler(source, 'iip')._header.width = '500px'
      handler(target, 'iip').restorePendingCheckpoint(checkpoint)
      finish(target, 'iip')
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['kitty', 'iip'])(
    'clears previous %s uploads for an empty checkpoint without allocating',
    (protocol) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        start(target, protocol)
        checkpoint = handler(source, protocol).capturePendingCheckpoint(0)
        const memory = vi.spyOn(WebAssembly, 'Memory')
        handler(target, protocol).restorePendingCheckpoint(checkpoint)
        expect(memory).not.toHaveBeenCalled()
        expect(
          protocol === 'kitty'
            ? handler(target, protocol)._pendingTransmissions.size
            : handler(target, protocol)._isMultipart
        ).toBe(protocol === 'kitty' ? 0 : false)
        vi.restoreAllMocks()
        start(target, protocol)
        finish(target, protocol)
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['kitty', 'iip'])(
    'rejects pending %s checkpoint use after target disposal',
    (protocol) => {
      const source = terminal(),
        target = terminal()
      const owner = handler(target, protocol)
      let checkpoint
      try {
        start(source, protocol)
        checkpoint = handler(source, protocol).capturePendingCheckpoint(1024)
        target.core.dispose()
        expect(() => owner.capturePendingCheckpoint(1024)).toThrow(/disposed/i)
        expect(() => owner.restorePendingCheckpoint(checkpoint)).toThrow(/disposed/i)
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['kitty', 'iip'])('rejects stale %s preparation after a target reset', (protocol) => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source, protocol)
      start(target, protocol)
      checkpoint = handler(source, protocol).capturePendingCheckpoint(1024)
      const Memory = WebAssembly.Memory
      vi.spyOn(WebAssembly, 'Memory').mockImplementation(function (options) {
        target.addon.reset()
        return new Memory(options)
      })
      expect(() => handler(target, protocol).restorePendingCheckpoint(checkpoint)).toThrow(
        /changed/i
      )
      vi.restoreAllMocks()
      expect(
        protocol === 'kitty'
          ? handler(target, protocol)._pendingTransmissions.size
          : handler(target, protocol)._isMultipart
      ).toBe(protocol === 'kitty' ? 0 : false)
      start(target, protocol)
      finish(target, protocol)
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['kitty', 'iip'])(
    'keeps the old %s upload when its lease expires during preparation',
    (protocol) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        start(source, protocol)
        start(target, protocol)
        checkpoint = handler(source, protocol).capturePendingCheckpoint(1024)
        const Memory = WebAssembly.Memory
        vi.spyOn(WebAssembly, 'Memory').mockImplementation(function (options) {
          checkpoint.dispose()
          return new Memory(options)
        })
        expect(() => handler(target, protocol).restorePendingCheckpoint(checkpoint)).toThrow(
          /disposed/i
        )
        vi.restoreAllMocks()
        finish(target, protocol)
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['kitty', 'iip'])(
    'fails %s capture explicitly if the pinned decoder layout changes',
    (protocol) => {
      const source = terminal()
      let decoder, states
      try {
        start(source, protocol)
        const owner = handler(source, protocol)
        decoder = protocol === 'kitty' ? owner._pendingTransmissions.get(7).decoder : owner._dec
        states = decoder._m32
        decoder._m32 = new Uint32Array(0)
        expect(() => owner.capturePendingCheckpoint(1024)).toThrow(/layout/i)
      } finally {
        if (decoder) {
          decoder._m32 = states
        }
        source.core.dispose()
      }
    }
  )

  it('owns Kitty command fields and leaves cursor/replies unchanged during installation', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    const replies = vi.fn()
    target.core.onData(replies)
    try {
      start(source, 'kitty')
      checkpoint = handler(source, 'kitty').capturePendingCheckpoint(1024)
      handler(source, 'kitty')._pendingTransmissions.get(7).cmd.width = 500
      expect(Object.isFrozen(checkpoint.metadata.pending[0].command)).toBe(true)
      write(target, '\x1b[4;5H')
      handler(target, 'kitty').restorePendingCheckpoint(checkpoint)
      expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual([4, 3])
      expect(replies).not.toHaveBeenCalled()
      finish(target, 'kitty')
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })
})
