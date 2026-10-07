import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const write = (h, value) => h.core._core.writeSync(value)
const sixel = (body) => `\x1bPq${body}\x1b\\`
const limit = (n) => `\x1b[?1;3;${n}S`
const handler = (h) => h.addon._handlers.get('sixel')
const image = (h) => [...h.storage._images.values()].at(-1)?.orig
const red = '#1;2;100;0;0#1'
const greenHigh = '#513;2;0;100;0#513'
const draw = (register) => sixel(`"1;1;12;24#${register}!12~-!12~-!12~-!12~`)

function modified(checkpoint, change) {
  const resources = new Map(
    checkpoint.metadata.resources.map((r) => [r.id, checkpoint.readResource(r.id, 0, r.byteLength)])
  )
  return new checkpoint.constructor(
    change(structuredClone(checkpoint.metadata), resources),
    resources
  )
}

describe('persistent SIXEL checkpoint component', () => {
  it('preserves all registers, including those above a temporarily reduced palette limit', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, sixel(red + greenHigh) + limit(16))
      const allocate = vi.spyOn(WebAssembly, 'Instance')
      checkpoint = handler(source).captureStateCheckpoint(16384)
      expect(allocate).not.toHaveBeenCalled()
      source.core.dispose()
      handler(target).restoreStateCheckpoint(checkpoint)
      expect(allocate).not.toHaveBeenCalled()
      vi.restoreAllMocks()
      expect(target.addon._opts.sixelPaletteLimit).toBe(16)
      write(target, draw(513))
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([255, 0, 0, 255])
      write(target, limit(4096) + draw(513))
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([true, false])(
    'preserves scrolling=%j and sends no replies or cursor movement during restore',
    (scrolling) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, `\x1b[?80${scrolling ? 'l' : 'h'}${limit(16)}${sixel(red)}\x1b[4;3H`)
        write(target, '\x1b[4;3H')
        const cursor = [target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]
        const reply = vi.fn()
        target.core.onData(reply)
        checkpoint = handler(source).captureStateCheckpoint(16384)
        handler(target).restoreStateCheckpoint(checkpoint)
        expect(target.addon._opts.sixelScrolling).toBe(scrolling)
        expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual(
          cursor
        )
        expect(reply).not.toHaveBeenCalled()
        write(target, '\x1b[?1;1S')
        expect(reply).toHaveBeenCalledExactlyOnceWith('\x1b[?1;0;16S')
        write(source, draw(1))
        write(target, draw(1))
        expect(image(target).data).toEqual(image(source).data)
        expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual([
          source.core.buffer.active.cursorX,
          source.core.buffer.active.cursorY
        ])
        expect([...target.storage._images.values()].at(-1).marker?.line).toEqual(
          [...source.storage._images.values()].at(-1).marker?.line
        )
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('owns frozen metadata and little-endian palette bytes after mutation and disposal', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, transported
    try {
      write(source, sixel(red + greenHigh))
      checkpoint = handler(source).captureStateCheckpoint(16384)
      expect(Object.isFrozen(checkpoint.metadata)).toBe(true)
      const bytes = checkpoint.readResource(1, 0, 16384)
      expect(Array.from(bytes.slice(4, 8))).toEqual([255, 0, 0, 255])
      transported = modified(checkpoint, (m) => JSON.parse(JSON.stringify(m)))
      bytes.fill(0)
      handler(source)._palette.fill(0)
      source.core.dispose()
      checkpoint.dispose()
      handler(target).restoreStateCheckpoint(transported)
      write(target, draw(513))
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
    } finally {
      transported?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('uses the target local defaults after reset rather than replacing them with source program options', () => {
    const source = terminal(),
      target = terminal(false, { sixelPaletteLimit: 256, sixelScrolling: true })
    let checkpoint
    try {
      write(source, `\x1b[?80h${limit(16)}${sixel(red)}`)
      checkpoint = handler(source).captureStateCheckpoint(16384)
      handler(target).restoreStateCheckpoint(checkpoint)
      target.addon.reset()
      expect(target.addon._opts.sixelPaletteLimit).toBe(256)
      expect(target.addon._opts.sixelScrolling).toBe(true)
      write(target, draw(1))
      expect(Array.from(image(target).data.slice(0, 4))).not.toEqual([255, 0, 0, 255])
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('preserves register changes made by a canceled image', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1bPq${red}#1\x18`)
      checkpoint = handler(source).captureStateCheckpoint(16384)
      handler(target).restoreStateCheckpoint(checkpoint)
      write(target, draw(1))
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([255, 0, 0, 255])
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('rejects capture while SIXEL is active, including after an addon reset', () => {
    const source = terminal()
    try {
      write(source, `\x1bPq${red}`)
      expect(() => handler(source).captureStateCheckpoint(16384)).toThrow(/active/i)
      source.addon.reset()
      expect(() => handler(source).captureStateCheckpoint(16384)).toThrow(/active/i)
      write(source, '\x1b\\')
      const checkpoint = handler(source).captureStateCheckpoint(16384)
      checkpoint.dispose()
    } finally {
      source.core.dispose()
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
      'truncated palette',
      (m, r) => {
        r.set(1, r.get(1).slice(4))
        return m
      }
    ],
    ['invalid scrolling', (m) => ({ ...m, sixelScrolling: 0 })],
    ['invalid palette limit', (m) => ({ ...m, sixelPaletteLimit: 4097 })],
    ['fractional palette limit', (m) => ({ ...m, sixelPaletteLimit: 1.5 })],
    ['invalid resource length', (m) => ({ ...m, byteLength: 16380 })],
    ['missing descriptor', (m) => ({ ...m, resources: [] })]
  ])('rejects %s and preserves the target state and completed images', (_name, change) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      write(source, sixel(red))
      write(target, sixel(greenHigh) + draw(513))
      const completed = image(target),
        palette = handler(target)._palette.slice()
      checkpoint = handler(source).captureStateCheckpoint(16384)
      altered = modified(checkpoint, change)
      expect(() => handler(target).restoreStateCheckpoint(altered)).toThrow()
      expect(handler(target)._palette).toEqual(palette)
      expect(image(target)).toBe(completed)
      write(target, draw(513))
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
    } finally {
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['lease', 'reset', 'disposal', 'new SIXEL', 'program options', 'new state restore'])(
    'rejects %s change during preparation',
    (mode) => {
      const source = terminal(),
        target = terminal()
      let checkpoint, replacement
      try {
        write(source, sixel(red))
        write(target, sixel(greenHigh))
        checkpoint = handler(source).captureStateCheckpoint(16384)
        replacement = handler(target).captureStateCheckpoint(16384)
        const owner = handler(target),
          read = checkpoint.readResource.bind(checkpoint)
        checkpoint.readResource = (...args) => {
          if (mode === 'lease') {
            checkpoint.dispose()
          }
          if (mode === 'reset') {
            target.addon.reset()
          }
          if (mode === 'disposal') {
            target.core.dispose()
          }
          if (mode === 'new SIXEL') {
            write(target, sixel('#2;2;0;0;100#2'))
          }
          if (mode === 'program options') {
            write(target, limit(16))
          }
          if (mode === 'new state restore') {
            owner.restoreStateCheckpoint(replacement)
          }
          return read(...args)
        }
        expect(() => owner.restoreStateCheckpoint(checkpoint)).toThrow()
        if (mode === 'program options') {
          expect(target.addon._opts.sixelPaletteLimit).toBe(16)
        }
        if (!['disposal', 'reset'].includes(mode)) {
          write(target, draw(513))
          if (mode !== 'program options') {
            expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
          }
        }
      } finally {
        replacement?.dispose()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('installs owned metadata if caller fields change during resource preparation', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      write(source, `\x1b[?80h${limit(16)}${sixel(red)}`)
      checkpoint = handler(source).captureStateCheckpoint(16384)
      altered = modified(checkpoint, (m) => m)
      const read = altered.readResource.bind(altered)
      altered.readResource = (...args) => {
        altered.metadata.sixelPaletteLimit = 4096
        altered.metadata.sixelScrolling = true
        return read(...args)
      }
      handler(target).restoreStateCheckpoint(altered)
      expect(target.addon._opts.sixelPaletteLimit).toBe(16)
      expect(target.addon._opts.sixelScrolling).toBe(false)
      write(target, draw(513))
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([255, 0, 0, 255])
    } finally {
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('checks capture budget and rejects a nonempty target parser before replacing state', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, sixel(red))
      expect(() => handler(source).captureStateCheckpoint(16383)).toThrow(/budget/i)
      checkpoint = handler(source).captureStateCheckpoint(16384)
      write(target, `\x1bPq${greenHigh}`)
      const old = handler(target)._dec
      expect(() => handler(target).restoreStateCheckpoint(checkpoint)).toThrow(/boundary/i)
      expect(handler(target)._dec).toBe(old)
      write(target, '#513!12~\x1b\\')
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('preserves a zero palette limit as reported by the existing program query', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, limit(0))
      checkpoint = handler(source).captureStateCheckpoint(16384)
      handler(target).restoreStateCheckpoint(checkpoint)
      const reply = vi.fn()
      target.core.onData(reply)
      write(target, '\x1b[?1;1S')
      expect(reply).toHaveBeenCalledExactlyOnceWith('\x1b[?1;0;0S')
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('captures registers after the completed command ends at ESC before its backslash', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1bPq${red}\x1b`)
      checkpoint = handler(source).captureStateCheckpoint(16384)
      handler(target).restoreStateCheckpoint(checkpoint)
      write(target, draw(1))
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([255, 0, 0, 255])
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('rejects use after terminal disposal', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      checkpoint = handler(source).captureStateCheckpoint(16384)
      const owner = handler(target)
      target.core.dispose()
      expect(() => owner.captureStateCheckpoint(16384)).toThrow(/disposed/i)
      expect(() => owner.restoreStateCheckpoint(checkpoint)).toThrow(/disposed/i)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })
})
