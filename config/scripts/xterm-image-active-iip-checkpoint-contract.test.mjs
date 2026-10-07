import { PNG } from 'pngjs'
import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from(Array.from({ length: 200 * 200 }, (_, i) => [i % 256, 100, 0, 255]).flat())
const pixels = new PNG({ width: 200, height: 200 })
pixels.data.set(rgba)
const encoded = PNG.sync.write(pixels, { deflateLevel: 0 }).toString('base64')
const write = (h, value) => h.core._core.writeSync(value)
const osc = (value) => `\x1b]1337;${value}\x07`
const file = 'File=inline=1;width=200px;height=200px;preserveAspectRatio=0'
const multipart = 'MultipartFile=inline=1;width=200px;height=200px;preserveAspectRatio=0'
const handler = (h) => h.addon._handlers.get('iip')
const rendered = (h) => [...h.storage._images.values()][0]?.orig.data

function restore(source, target) {
  const checkpoint = handler(source).captureActiveCheckpoint(1024 * 1024)
  try {
    source.core.dispose()
    handler(target).restoreActiveCheckpoint(checkpoint)
    return checkpoint
  } catch (error) {
    checkpoint?.dispose()
    throw error
  }
}

describe('active IIP image checkpoint component', () => {
  it.each([
    0,
    1,
    2,
    3,
    131069,
    encoded.length - 4,
    encoded.length - 3,
    encoded.length - 2,
    encoded.length - 1,
    encoded.length
  ])('resumes a single File body at %i bytes using only new producer bytes', (cut) => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1b]1337;${file}:${encoded.slice(0, cut)}`)
      checkpoint = restore(source, target)
      write(target, `${encoded.slice(cut)}\x07`)
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('resumes every split in a header containing typed unknown fields and a UTF8 filename', () => {
    const headerRgba = new Uint8ClampedArray(
      Array.from({ length: 12 * 12 }, (_, i) => [i % 256, 100, 0, 255]).flat()
    )
    const headerImage = new PNG({ width: 12, height: 12 })
    headerImage.data.set(headerRgba)
    const headerBody = PNG.sync.write(headerImage, { deflateLevel: 0 }).toString('base64')
    const header = `${file.replaceAll('200px', '12px')};ignored=abc;name=${Buffer.from('图.png').toString('base64')}:`
    for (let cut = 0; cut <= header.length; cut++) {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, `\x1b]1337;${header.slice(0, cut)}`)
        checkpoint = restore(source, target)
        write(target, `${header.slice(cut)}${headerBody}\x07`)
        expect(rendered(target), `header cut ${cut}`).toEqual(headerRgba)
        expect(handler(target)._header.name).toBe('图.png')
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  })

  it.each([1, 2, 3, 131069])(
    'preserves multipart state while an active FilePart extends %i completed bytes',
    (cut) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, osc(multipart) + osc(`FilePart=${encoded.slice(0, cut)}`))
        write(source, `\x1b]1337;FilePart=${encoded.slice(cut, -4)}`)
        checkpoint = restore(source, target)
        expect(handler(target)._multipartEncodedSize).toBe(cut)
        write(target, `${encoded.slice(-4)}\x07${osc('FileEnd')}`)
        expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['FileP', 'FilePart=', 'FileEn', 'FileEnd', 'ReportCell'])(
    'preserves a healthy multipart decoder while parsing %j',
    (prefix) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        const complete = prefix.startsWith('FileP')
          ? 'FilePart='
          : prefix.startsWith('FileE')
            ? 'FileEnd'
            : 'ReportCellSize'
        write(source, osc(multipart) + osc(`FilePart=${encoded}`))
        write(source, `\x1b]1337;${prefix}`)
        checkpoint = restore(source, target)
        write(target, `${complete.slice(prefix.length)}\x07`)
        if (!complete.startsWith('FileEnd')) {
          write(target, osc('FileEnd'))
        }
        expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['Unknown=invalid', 'File=__proto__=invalid;'])(
    'keeps an older healthy multipart upload after malformed current header %j',
    (header) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, osc(multipart) + osc(`FilePart=${encoded.slice(0, 3)}`))
        write(source, `\x1b]1337;${header}`)
        expect(handler(source)._aborted).toBe(true)
        expect(handler(source)._abortMulti).toBe(false)
        checkpoint = restore(source, target)
        write(target, `ignored\x07${osc(`FilePart=${encoded.slice(3)}`)}${osc('FileEnd')}`)
        expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('preserves a released failed multipart decoder and permits the next healthy image', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `${osc(multipart)}\x1b]1337;FilePart=${'!'.repeat(131072)}`)
      expect(handler(source)._aborted).toBe(true)
      expect(handler(source)._abortMulti).toBe(true)
      checkpoint = restore(source, target)
      expect(checkpoint.metadata.base64).toBeUndefined()
      write(target, `ignored\x07${osc('FileEnd')}`)
      expect(target.storage._images.size).toBe(0)
      write(target, osc(`${file}:${encoded}`))
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('preserves reset-aborted input until the current OSC ends', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, `\x1b]1337;${file}:${encoded.slice(0, 131069)}`)
      source.addon.reset()
      checkpoint = restore(source, target)
      write(target, `${encoded.slice(131069)}\x07`)
      expect(target.storage._images.size).toBe(0)
      write(target, osc(`${file}:${encoded}`))
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['\x18', '\x1a'])(
    'cancels a restored FilePart on %j and accepts the next image',
    (cancel) => {
      const source = terminal(),
        target = terminal()
      let checkpoint
      try {
        write(source, osc(multipart) + osc(`FilePart=${encoded.slice(0, 3)}`))
        write(source, `\x1b]1337;FilePart=${encoded.slice(3, 131069)}`)
        checkpoint = restore(source, target)
        write(target, `${cancel}${osc('FileEnd')}`)
        expect(target.storage._images.size).toBe(0)
        write(target, osc(`${file}:${encoded}`))
        expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('captures a healthy single-file decoder with stale failed-multipart flags', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, osc(multipart) + osc(`FilePart=${'!'.repeat(131072)}`) + osc('FileEnd'))
      expect(handler(source)._abortMulti).toBe(true)
      write(source, `\x1b]1337;${file}:${encoded.slice(0, 131069)}`)
      checkpoint = restore(source, target)
      write(target, `${encoded.slice(131069)}\x07`)
      expect(rendered(target)).toEqual(new Uint8ClampedArray(rgba))
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('replies to a restored cell-size query only at its new termination', () => {
    const source = terminal(),
      target = terminal()
    let checkpoint
    try {
      write(source, '\x1b]1337;ReportCellSize')
      checkpoint = handler(source).captureActiveCheckpoint(0)
      const reply = vi.fn()
      target.core.onData(reply)
      handler(target).restoreActiveCheckpoint(checkpoint)
      expect(reply).not.toHaveBeenCalled()
      write(target, '\x07')
      expect(reply).toHaveBeenCalledExactlyOnceWith(
        '\x1b]1337;ReportCellSize=2.000;2.000;1.000\x1b\\'
      )
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('does not capture a completed image or an unrelated OSC identifier', () => {
    const h = terminal()
    try {
      write(h, `\x1b]1337;${file}:${encoded}\x1b`)
      expect(handler(h).captureActiveCheckpoint(1024)).toBeUndefined()
      write(h, '\\\x1b]2;TITLE')
      expect(handler(h).captureActiveCheckpoint(1024)).toBeUndefined()
    } finally {
      h.core.dispose()
    }
  })
})
