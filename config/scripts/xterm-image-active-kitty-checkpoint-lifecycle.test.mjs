import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from(Array.from({ length: 200 * 200 }, () => [255, 100, 0, 255]).flat())
const encoded = rgba.toString('base64')
const write = (h, value) => h.core._core.writeSync(value)
const kitty = (command, payload = '') => `\x1b_G${command};${payload}\x1b\\`
const handler = (h) => h.addon._handlers.get('kitty')
const start = (h) => write(h, `\x1b_Ga=t,f=32,s=200,v=200,i=7,q=2;${encoded.slice(0, 131069)}`)
const pending = (h) => write(h, kitty('a=t,f=32,s=200,v=200,i=9,m=1,q=2', encoded.slice(0, 3)))
const finishPending = (h) => {
  write(h, kitty('m=0,q=2', encoded.slice(3)))
  expect(h.kittyStorage.getImage(9).data).toEqual(new Uint8Array(rgba))
}

function modified(checkpoint, change) {
  const resources = new Map(
    checkpoint.metadata.resources.map((r) => [r.id, checkpoint.readResource(r.id, 0, r.byteLength)])
  )
  return new checkpoint.constructor(change(checkpoint.metadata, resources), resources)
}

describe('active Kitty checkpoint validation and ownership', () => {
  it('preserves unrelated pending uploads, completed sources, cursor and replies', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source)
      write(target, kitty('a=t,f=32,s=200,v=200,i=19,q=2', encoded))
      pending(target)
      const completed = target.kittyStorage.getImage(19)
      const old = handler(target)._pendingTransmissions.get(9)
      const cursor = [target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]
      const reply = vi.fn()
      target.core.onData(reply)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      source.core.dispose()
      handler(target).restoreActiveCheckpoint(checkpoint)
      expect(handler(target)._pendingTransmissions.get(9)).toBe(old)
      expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual(cursor)
      expect(reply).not.toHaveBeenCalled()
      write(target, `${encoded.slice(131069)}\x1b\\`)
      expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
      finishPending(target)
      expect(target.kittyStorage.getImage(19)).toBe(completed)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('owns its frozen control and resource copies after source mutation and disposal', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      expect(Object.isFrozen(checkpoint.metadata)).toBe(true)
      expect(Object.isFrozen(checkpoint.metadata.control)).toBe(true)
      checkpoint.readResource(1, 0, 10).fill(0)
      handler(source)._controlData.fill(0)
      source.core.dispose()
      handler(target).restoreActiveCheckpoint(checkpoint)
      write(target, `${encoded.slice(131069)}\x1b\\`)
      expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([
    [
      'missing resource',
      (m, r) => {
        r.clear()
        return m
      }
    ],
    [
      'truncated resource',
      (m, r) => {
        r.set(1, r.get(1).slice(1))
        return m
      }
    ],
    ['invalid counter', (m) => ({ ...m, totalEncodedSize: m.totalEncodedSize + 1 })],
    ['invalid control point', (m) => ({ ...m, control: [0x110000] })],
    ['oversized control', (m) => ({ ...m, control: Array(513).fill(65) })],
    ['incorrect phase', (m) => ({ ...m, inControlData: true })],
    ['invalid flag', (m) => ({ ...m, aborted: 'false' })],
    ['missing alias', (m) => ({ ...m, pendingKey: 42 })],
    ['unexpected descriptor', (m) => ({ ...m, resources: [] })]
  ])('rejects %s before allocation and preserves the old target', (_name, change) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      start(source)
      pending(target)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      altered = modified(checkpoint, change)
      const old = handler(target)._pendingTransmissions.get(9)
      const allocate = vi.spyOn(WebAssembly, 'Memory')
      expect(() => handler(target).restoreActiveCheckpoint(altered)).toThrow()
      expect(allocate).not.toHaveBeenCalled()
      expect(handler(target)._pendingTransmissions.get(9)).toBe(old)
      vi.restoreAllMocks()
      finishPending(target)
    } finally {
      vi.restoreAllMocks()
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['allocation', 'lease', 'reset', 'new image command'])(
    'rejects %s failure during preparation',
    (mode) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        start(source)
        pending(target)
        checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
        const old = handler(target)._pendingTransmissions.get(9)
        const Memory = WebAssembly.Memory
        vi.spyOn(WebAssembly, 'Memory').mockImplementation(function (options) {
          if (mode === 'allocation') {
            throw new Error('active allocation rejected')
          }
          if (mode === 'lease') {
            checkpoint.dispose()
          }
          if (mode === 'reset') {
            target.addon.reset()
          }
          if (mode === 'new image command') {
            write(target, kitty('a=q,i=123,q=2'))
          }
          return new Memory(options)
        })
        expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow()
        vi.restoreAllMocks()
        expect(target.core._core._inputHandler._parser.currentState).toBe(0)
        if (mode === 'reset') {
          expect(handler(target)._pendingTransmissions.size).toBe(0)
        } else {
          expect(handler(target)._pendingTransmissions.get(9)).toBe(old)
          finishPending(target)
        }
        write(target, kitty('a=t,f=32,s=200,v=200,i=8,q=2', encoded))
        expect(target.kittyStorage.getImage(8).data).toEqual(new Uint8Array(rgba))
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('rejects a nonempty target parser before allocating or replacing its active command', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source)
      start(target)
      const decoder = handler(target)._activeDecoder
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      const allocate = vi.spyOn(WebAssembly, 'Memory')
      expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow(/boundary/i)
      expect(allocate).not.toHaveBeenCalled()
      expect(handler(target)._activeDecoder).toBe(decoder)
      vi.restoreAllMocks()
      write(target, `${encoded.slice(131069)}\x1b\\`)
      expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('checks capture and target byte limits without losing healthy uploads', () => {
    const source = terminal(),
      target = terminal(false, { kittySizeLimit: 1024 })
    let checkpoint
    try {
      start(source)
      expect(() => handler(source).captureActiveCheckpoint(1)).toThrow(/budget/i)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      const allocate = vi.spyOn(WebAssembly, 'Memory')
      expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow(/limit/i)
      expect(allocate).not.toHaveBeenCalled()
      vi.restoreAllMocks()
      write(source, `${encoded.slice(131069)}\x1b\\`)
      expect(source.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('checks combined active and pending capacity before allocation', () => {
    const source = terminal(),
      target = terminal(false, { storageLimit: 12 })
    let checkpoint
    try {
      start(source)
      pending(target)
      const old = handler(target)._pendingTransmissions.get(9)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      const allocate = vi.spyOn(WebAssembly, 'Memory')
      expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow(/capacity budget/i)
      expect(allocate).not.toHaveBeenCalled()
      expect(handler(target)._pendingTransmissions.get(9)).toBe(old)
      vi.restoreAllMocks()
      finishPending(target)
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('rejects API use after handler disposal', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      const owner = handler(target)
      target.core.dispose()
      expect(() => owner.captureActiveCheckpoint(1024)).toThrow(/disposed/i)
      expect(() => owner.restoreActiveCheckpoint(checkpoint)).toThrow(/disposed/i)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('installs the owned preparation state when caller metadata changes during allocation', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      start(source)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      altered = modified(checkpoint, (m) => ({ ...m, control: [...m.control] }))
      const Memory = WebAssembly.Memory
      vi.spyOn(WebAssembly, 'Memory').mockImplementation(function (options) {
        altered.metadata.control.fill(0)
        altered.metadata.decodeError = true
        altered.metadata.totalEncodedSize = 0
        return new Memory(options)
      })
      handler(target).restoreActiveCheckpoint(altered)
      vi.restoreAllMocks()
      write(target, `${encoded.slice(131069)}\x1b\\`)
      expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      vi.restoreAllMocks()
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })
})
