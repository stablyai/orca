import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from(Array.from({ length: 200 * 200 }, () => [255, 100, 0, 255]).flat())
const png = new PNG({ width: 200, height: 200 })
png.data.set(rgba)
const encoded = PNG.sync.write(png, { deflateLevel: 0 }).toString('base64')
const write = (h, value) => h.core._core.writeSync(value)
const osc = (value) => `\x1b]1337;${value}\x07`
const file = 'File=inline=1;width=200px;height=200px;preserveAspectRatio=0'
const multipart = file.replace('File=', 'MultipartFile=')
const handler = (h) => h.addon._handlers.get('iip')
const start = (h) => write(h, `\x1b]1337;${file}:${encoded.slice(0, 131069)}`)
const pending = (h) => write(h, osc(multipart) + osc(`FilePart=${encoded.slice(0, 3)}`))
const rendered = (h) => [...h.storage._images.values()].at(-1)?.orig.data
const finishPending = (h) => {
  write(h, osc(`FilePart=${encoded.slice(3)}`) + osc('FileEnd'))
  expect(rendered(h)).toEqual(new Uint8ClampedArray(rgba))
}
function modified(checkpoint, change) {
  const resources = new Map(
    checkpoint.metadata.resources.map((r) => [r.id, checkpoint.readResource(r.id, 0, r.byteLength)])
  )
  return new checkpoint.constructor(
    change(structuredClone(checkpoint.metadata), resources),
    resources
  )
}

describe('active IIP checkpoint validation and ownership', () => {
  it('owns frozen typed header fields and resources after the source is disposed', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, transported
    try {
      write(
        source,
        `\x1b]1337;${file};ignored=abc;size=${'9'.repeat(400)}:${encoded.slice(0, 131069)}`
      )
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      expect(Object.isFrozen(checkpoint.metadata.headerParser.fields.entries)).toBe(true)
      const unknown = checkpoint.metadata.headerParser.fields.entries.find(
        (entry) => entry.name === 'ignored'
      ).value
      expect(Object.isFrozen(unknown.points)).toBe(true)
      expect(
        checkpoint.metadata.header.entries.find((entry) => entry.name === 'size').value.text
      ).toBe('Infinity')
      checkpoint.readResource(1, 0, 10).fill(0)
      handler(source)._hp.fields.ignored.fill(0)
      source.core.dispose()
      transported = modified(checkpoint, (m) => JSON.parse(JSON.stringify(m)))
      handler(target).restoreActiveCheckpoint(transported)
      expect(handler(target)._header.size).toBe(Infinity)
      expect(handler(target)._hp.fields.ignored).toEqual(new Uint32Array([97, 98, 99]))
      write(target, `${encoded.slice(131069)}\x07`)
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      transported?.dispose()
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
    ['invalid flag', (m) => ({ ...m, aborted: 'false' })],
    ['missing decoder', (m) => ({ ...m, base64: undefined })],
    ['invalid descriptor', (m) => ({ ...m, resources: [] })],
    ['invalid completed counter', (m) => ({ ...m, multipartEncodedSize: -1 })],
    ['invalid parser state', (m) => ({ ...m, headerParser: { ...m.headerParser, state: 9 } })],
    [
      'invalid parser point',
      (m) => ({ ...m, headerParser: { ...m.headerParser, buffer: [0x110000] } })
    ],
    [
      'oversized parser buffer',
      (m) => ({ ...m, headerParser: { ...m.headerParser, buffer: Array(1025).fill(65) } })
    ],
    [
      'oversized parser key',
      (m) => ({ ...m, headerParser: { ...m.headerParser, key: 'x'.repeat(1025) } })
    ],
    ['invalid header byte count', (m) => ({ ...m, headerByteLength: 0 })],
    [
      'too many fields',
      (m) => {
        m.headerParser.fields.entries = Array(129).fill(m.headerParser.fields.entries[0])
        return m
      }
    ],
    [
      'duplicate field',
      (m) => {
        m.header.entries.push(m.header.entries[0])
        return m
      }
    ],
    [
      'invalid numeric token',
      (m) => {
        m.header.entries.find((e) => e.name === 'size').value.text = '0x1'
        return m
      }
    ],
    [
      'invalid field type',
      (m) => {
        m.header.entries[0].value.kind = 'unrecognized'
        return m
      }
    ]
  ])('rejects %s before decoder allocation and preserves the target upload', (_name, change) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      start(source)
      pending(target)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      altered = modified(checkpoint, change)
      const old = handler(target)._dec
      const allocate = vi.spyOn(WebAssembly, 'Memory')
      expect(() => handler(target).restoreActiveCheckpoint(altered)).toThrow()
      expect(allocate).not.toHaveBeenCalled()
      expect(handler(target)._dec).toBe(old)
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

  it.each(['allocation', 'lease', 'reset', 'new image command', 'disposal'])(
    'rejects %s failure during preparation',
    (mode) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        start(source)
        pending(target)
        checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
        const owner = handler(target),
          old = owner._dec
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
            write(target, osc('ReportCellSize'))
          }
          if (mode === 'disposal') {
            target.core.dispose()
          }
          return new Memory(options)
        })
        expect(() => owner.restoreActiveCheckpoint(checkpoint)).toThrow()
        vi.restoreAllMocks()
        if (mode !== 'reset' && mode !== 'disposal') {
          expect(owner._dec).toBe(old)
          finishPending(target)
        }
        if (mode !== 'disposal') {
          expect(target.core._core._inputHandler._parser.currentState).toBe(0)
          write(target, osc(`${file}:${encoded}`))
          expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
        }
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('installs owned flags and typed fields if caller metadata changes during allocation', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      start(source)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      altered = modified(checkpoint, (m) => m)
      const Memory = WebAssembly.Memory
      vi.spyOn(WebAssembly, 'Memory').mockImplementation(function (options) {
        altered.metadata.aborted = true
        altered.metadata.headerParser.buffer.fill(0)
        altered.metadata.header.entries.find((e) => e.name === 'inline').value.text = '0'
        return new Memory(options)
      })
      handler(target).restoreActiveCheckpoint(altered)
      vi.restoreAllMocks()
      write(target, `${encoded.slice(131069)}\x07`)
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      vi.restoreAllMocks()
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('rejects an active target parser before allocating and leaves its upload intact', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source)
      start(target)
      const old = handler(target)._dec
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      const allocate = vi.spyOn(WebAssembly, 'Memory')
      expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow(/boundary/i)
      expect(allocate).not.toHaveBeenCalled()
      expect(handler(target)._dec).toBe(old)
      vi.restoreAllMocks()
      write(target, `${encoded.slice(131069)}\x07`)
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([{ iipSizeLimit: 1024 }, { storageLimit: 1 }])(
    'checks target payload/capacity budgets before allocation: %j',
    (options) => {
      const source = terminal(),
        target = terminal(false, options)
      let checkpoint
      try {
        start(source)
        expect(() => handler(source).captureActiveCheckpoint(1)).toThrow(/budget/i)
        checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
        const allocate = vi.spyOn(WebAssembly, 'Memory')
        expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow(/limit|budget/i)
        expect(allocate).not.toHaveBeenCalled()
        vi.restoreAllMocks()
        write(source, `${encoded.slice(131069)}\x07`)
        expect(rendered(source)).toEqual(new Uint8ClampedArray(rgba))
      } finally {
        vi.restoreAllMocks()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('bounds source header field count without aborting the active source command', () => {
    const source = terminal()
    try {
      write(
        source,
        `\x1b]1337;${file};${Array.from({ length: 129 }, (_, i) => `field${i}=x`).join(';')};name=`
      )
      expect(() => handler(source).captureActiveCheckpoint(1024)).toThrow(/too many/i)
      write(source, `${Buffer.from('valid.png').toString('base64')}:${encoded}\x07`)
      expect(rendered(source)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      source.core.dispose()
    }
  })

  it('replaces older multipart ownership once while preserving completed images, cursor and replies', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      start(source)
      write(target, osc(`${file}:${encoded}`))
      const completed = [...target.storage._images.values()][0]
      pending(target)
      const old = handler(target)._dec
      const release = vi.spyOn(old, 'release')
      const cursor = [target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]
      const reply = vi.fn()
      target.core.onData(reply)
      checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
      handler(target).restoreActiveCheckpoint(checkpoint)
      expect(release).toHaveBeenCalledTimes(1)
      expect(handler(target)._dec).not.toBe(old)
      expect([...target.storage._images.values()][0]).toBe(completed)
      expect([target.core.buffer.active.cursorX, target.core.buffer.active.cursorY]).toEqual(cursor)
      expect(reply).not.toHaveBeenCalled()
      write(target, `${encoded.slice(131069)}\x07`)
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('bounds aggregate source header bytes before copying fields and leaves the producer usable', () => {
    const source = terminal()
    try {
      const fields = Array.from({ length: 20 }, (_, i) => `field${i}=${'x'.repeat(1024)}`).join(';')
      write(source, `\x1b]1337;${file};${fields};name=`)
      expect(() => handler(source).captureActiveCheckpoint(1024)).toThrow(/header.*budget/i)
      write(source, `${Buffer.from('valid.png').toString('base64')}:${encoded}\x07`)
      expect(rendered(source)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      source.core.dispose()
    }
  })

  it('rejects use after handler disposal', () => {
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
})
