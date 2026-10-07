import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const write = (h, value) => h.core._core.writeSync(value)
const handler = (h) => h.addon._handlers.get('sixel')
const image = (h) => [...h.storage._images.values()].at(-1)?.orig
const red = '#1;2;100;0;0#1'
const green = '#513;2;0;100;0#513'
const finish = '\x1b\\after'
const cases = [
  ['raster and color', `"1;1;12;18${red}!12~-!8~-!4~`],
  ['variable widths', `${red}!12~$#2;2;0;0;100#2!3~-!24~-!30~`],
  ['partial raster recovery', `"1;1;12${red}!12~-!8~`],
  ['empty bands', `${red}--!12~--!8~`]
]

function modified(checkpoint, change) {
  const resources = new Map(
    checkpoint.metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
  )
  return new checkpoint.constructor(
    change(structuredClone(checkpoint.metadata), resources),
    resources
  )
}

function snapshot(h) {
  const raster = image(h)
  return {
    width: raster?.width,
    height: raster?.height,
    data: raster?.data?.slice(),
    text: h.serializer.serialize(),
    count: h.storage._images.size
  }
}

describe('active SIXEL checkpoint component', () => {
  it.each(cases)('resumes every split in %s without changing the source decoder', (_name, body) => {
    const control = terminal()
    try {
      write(control, `\x1bPq${body}${finish}`)
      const expected = snapshot(control)
      for (let cut = 0; cut < body.length; cut++) {
        const source = terminal(),
          target = terminal()
        let checkpoint
        try {
          write(source, `\x1bPq${body.slice(0, cut)}`)
          checkpoint = handler(source).captureActiveCheckpoint(32 * 1024 * 1024)
          expect(checkpoint).toBeDefined()
          write(source, body.slice(cut) + finish)
          expect(snapshot(source)).toEqual(expected)
          source.core.dispose()
          handler(target).restoreActiveCheckpoint(checkpoint)
          write(target, body.slice(cut) + finish)
          expect(snapshot(target)).toEqual(expected)
        } finally {
          checkpoint?.dispose()
          source.core.dispose()
          target.core.dispose()
        }
      }
    } finally {
      control.core.dispose()
    }
  })

  it.each([false, true])(
    'owns transparent=%j fill and palette across JSON transport',
    (transparent) => {
      const source = terminal(),
        target = terminal()
      let checkpoint, transported
      try {
        const body = `"1;1;12;18${red}!12~-${green}!8~-!4~`
        write(source, `\x1bP0;${transparent ? 1 : 0}q${body.slice(0, -2)}`)
        checkpoint = handler(source).captureActiveCheckpoint(32 * 1024 * 1024)
        transported = modified(checkpoint, (m) => JSON.parse(JSON.stringify(m)))
        write(source, body.slice(-2) + finish)
        const expected = snapshot(source)
        source.core.dispose()
        checkpoint.dispose()
        handler(target).restoreActiveCheckpoint(transported)
        write(target, body.slice(-2) + finish)
        expect(snapshot(target)).toEqual(expected)
        write(target, '\x1bPq"1;1;1;6#513~\x1b\\')
        expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
      } finally {
        transported?.dispose()
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['reset', 'size limit', 'memory limit'])('restores the ignore phase after %s', (mode) => {
    const source = terminal(
        false,
        mode === 'size limit'
          ? { sixelSizeLimit: 2 }
          : mode === 'memory limit'
            ? { pixelLimit: 1 }
            : {}
      ),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1bPq"1;1;12;18${red}~`)
      if (mode === 'reset') {
        source.addon.reset()
      }
      expect(handler(source)._aborted).toBe(true)
      checkpoint = handler(source).captureActiveCheckpoint(32768)
      handler(target).restoreActiveCheckpoint(checkpoint)
      expect(handler(target)._dec).toBeUndefined()
      write(target, `!12~${finish}`)
      expect(target.storage._images.size).toBe(0)
      expect(target.core.buffer.active.getLine(0).translateToString(true)).toBe('after')
      write(target, '\x1bPq"1;1;1;6#1~\x1b\\')
      expect(target.storage._images.size).toBe(1)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['\x18', '\x1a'])('cancels a restored command at %j and recovers', (cancel) => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1bPq"1;1;12;18${red}!12~-!8`)
      checkpoint = handler(source).captureActiveCheckpoint(32768)
      handler(target).restoreActiveCheckpoint(checkpoint)
      write(target, `${cancel}after`)
      expect(target.storage._images.size).toBe(0)
      expect(handler(target)._dec).toBeUndefined()
      write(target, '\x1bPq"1;1;1;6#1~\x1b\\')
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([255, 0, 0, 255])
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('returns no active checkpoint after completion or cancellation', () => {
    const h = terminal()
    try {
      expect(handler(h).captureActiveCheckpoint(32768)).toBeUndefined()
      write(h, '\x1bPq~\x1b')
      expect(handler(h).captureActiveCheckpoint(32768)).toBeUndefined()
      write(h, '\\')
      write(h, '\x1bPq~\x18')
      expect(handler(h).captureActiveCheckpoint(32768)).toBeUndefined()
    } finally {
      h.core.dispose()
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
      'truncated pixels',
      (m, r) => {
        r.set(2, r.get(2).slice(4))
        return m
      }
    ],
    ['invalid ownership', (m) => ({ ...m, aborted: true })],
    ['invalid counter', (m) => ({ ...m, size: -1 })],
    [
      'invalid parser state',
      (m) => {
        m.decoder.parserState = 13
        return m
      }
    ],
    [
      'invalid dimensions',
      (m) => {
        m.decoder.width = 20000
        return m
      }
    ],
    ['invalid byte length', (m) => ({ ...m, byteLength: m.byteLength + 4 })]
  ])('rejects %s before changing a target or allocating WASM', (_name, change) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      write(source, `\x1bPq"1;1;12;18${red}!12~-!8~`)
      write(target, `\x1bPq"1;1;1;6${green}~\x1b\\`)
      const expected = snapshot(target)
      checkpoint = handler(source).captureActiveCheckpoint(32768)
      altered = modified(checkpoint, change)
      const allocate = vi.spyOn(WebAssembly, 'Instance')
      expect(() => handler(target).restoreActiveCheckpoint(altered)).toThrow()
      expect(allocate).not.toHaveBeenCalled()
      expect(snapshot(target)).toEqual(expected)
      expect(handler(target)._dec).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([
    'lease',
    'reset',
    'disposal',
    'new command',
    'new state restore',
    'pixel limit',
    'size limit'
  ])('rejects %s during preparation', (mode) => {
    const source = terminal(),
      target = terminal()
    let checkpoint, persistent
    try {
      write(source, `\x1bPq"1;1;12;18${red}!12~-!8~`)
      checkpoint = handler(source).captureActiveCheckpoint(32768)
      persistent = handler(target).captureStateCheckpoint(16384)
      const owner = handler(target),
        read = checkpoint.readResource.bind(checkpoint)
      let changed = false
      checkpoint.readResource = (...args) => {
        if (!changed) {
          changed = true
          if (mode === 'lease') {
            checkpoint.dispose()
          }
          if (mode === 'reset') {
            target.addon.reset()
          }
          if (mode === 'disposal') {
            target.core.dispose()
          }
          if (mode === 'new command') {
            write(target, `\x1bPq${green}!3`)
          }
          if (mode === 'new state restore') {
            owner.restoreStateCheckpoint(persistent)
          }
          if (mode === 'pixel limit') {
            target.addon._opts.pixelLimit = 1
          }
          if (mode === 'size limit') {
            target.addon._opts.sixelSizeLimit = 1
          }
        }
        return read(...args)
      }
      expect(() => owner.restoreActiveCheckpoint(checkpoint)).toThrow()
      if (mode === 'new command') {
        write(target, `~${finish}`)
        expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
      } else {
        expect(owner._dec).toBeUndefined()
      }
    } finally {
      persistent?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('captures without flushing pixel getters or changing the live parser state', () => {
    const h = terminal()
    let checkpoint
    try {
      write(h, `\x1bPq${red}!12~-!24~-!3`)
      const dec = handler(h)._dec
      const before = new Uint8Array(dec._states.buffer).slice()
      const canvas = dec._canvas.slice()
      checkpoint = handler(h).captureActiveCheckpoint(32768)
      expect(new Uint8Array(dec._states.buffer)).toEqual(before)
      expect(dec._canvas).toEqual(canvas)
      expect(Object.isFrozen(checkpoint.metadata.decoder.params)).toBe(true)
    } finally {
      checkpoint?.dispose()
      h.core.dispose()
    }
  })

  it('rejects an insufficient byte budget and preserves the healthy producer', () => {
    const h = terminal()
    try {
      write(h, `\x1bPq"1;1;12;18${red}!12~-!8`)
      expect(() => handler(h).captureActiveCheckpoint(16384)).toThrow(/budget/i)
      write(h, `~${finish}`)
      expect(h.storage._images.size).toBe(1)
    } finally {
      h.core.dispose()
    }
  })

  it('rejects a nonempty target parser and preserves its decoder and continuation', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1bPq${red}!3`)
      checkpoint = handler(source).captureActiveCheckpoint(32768)
      write(target, `\x1bPq${green}!3`)
      const decoder = handler(target)._dec
      expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow(/boundary/i)
      expect(handler(target)._dec).toBe(decoder)
      write(target, `~${finish}`)
      expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('keeps metadata owned when caller fields change during resource reads', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint, altered
    try {
      write(source, `\x1bPq"1;1;12;18${red}!12~-!8`)
      checkpoint = handler(source).captureActiveCheckpoint(32768)
      altered = modified(checkpoint, (m) => m)
      const read = altered.readResource.bind(altered)
      altered.readResource = (...args) => {
        altered.metadata.decoder.width = 20000
        altered.metadata.decoder.params[0] = 1000
        altered.metadata.aborted = true
        return read(...args)
      }
      handler(target).restoreActiveCheckpoint(altered)
      write(source, `~${finish}`)
      write(target, `~${finish}`)
      expect(snapshot(target)).toEqual(snapshot(source))
    } finally {
      altered?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['lease', 'reset', 'new command'])('rejects %s during decoder allocation', (mode) => {
    const source = terminal(),
      target = terminal(false, {
        pixelLimit: 7_999_991 - ['lease', 'reset', 'new command'].indexOf(mode)
      })
    let checkpoint
    try {
      write(source, `\x1bPq"1;1;12;18${red}!12~-!8`)
      checkpoint = handler(source).captureActiveCheckpoint(32768)
      const Original = WebAssembly.Instance
      const allocation = vi.spyOn(WebAssembly, 'Instance').mockImplementationOnce(function (
        ...args
      ) {
        if (mode === 'lease') {
          checkpoint.dispose()
        }
        if (mode === 'reset') {
          target.addon.reset()
        }
        if (mode === 'new command') {
          write(target, `\x1bPq${green}!3`)
        }
        return Reflect.construct(Original, args)
      })
      expect(() => handler(target).restoreActiveCheckpoint(checkpoint)).toThrow()
      expect(allocation).toHaveBeenCalled()
      vi.restoreAllMocks()
      if (mode === 'new command') {
        write(target, `~${finish}`)
        expect(Array.from(image(target).data.slice(0, 4))).toEqual([0, 255, 0, 255])
      } else {
        expect(handler(target)._dec).toBeUndefined()
      }
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('rejects a truncated private pixel window before copying uninitialized bands', () => {
    const h = terminal()
    try {
      write(h, `\x1bPq${red}!12~`)
      const dec = handler(h)._dec
      const original = dec._pSrc
      try {
        dec._pSrc = original.subarray(0, 1)
        expect(() => handler(h).captureActiveCheckpoint(32768)).toThrow(/layout/i)
      } finally {
        dec._pSrc = original
      }
      write(h, finish)
      expect(h.storage._images.size).toBe(1)
    } finally {
      h.core.dispose()
    }
  })
})
