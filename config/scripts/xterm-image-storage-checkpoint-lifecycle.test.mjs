import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

function add(h, value = 255) {
  h.core._core.writeSync(
    `\x1b_Ga=T,f=32,s=2,v=2,q=2;${Buffer.from(Array.from({ length: 4 }, () => [value, 0, 0, 255]).flat()).toString('base64')}\x1b\\`
  )
}

function browserDecoder() {
  let finish
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(data, width, height) {
        Object.assign(this, { data, width, height })
      }
    }
  )
  const bitmap = { width: 2, height: 2, close: vi.fn() }
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(bitmap)
        })
    )
  )
  return { bitmap, finish: () => finish() }
}

describe('image storage checkpoint preparation and disposal', () => {
  it.each(['geometry', 'pixel limit'])(
    'rejects an incompatible target %s before replacing its old image',
    async (reason) => {
      const source = terminal()
      const target = terminal()
      let checkpoint
      try {
        add(source)
        add(target, 50)
        const original = target.storage.getImageSpec(1)
        checkpoint = source.storage.captureCheckpoint(1024)
        if (reason === 'geometry') {
          target.core.resize(21, 10)
        } else {
          target.addon._opts.pixelLimit = 1
        }
        const convert = vi.spyOn(target.backend, 'fromRgba')
        await expect(target.storage.restoreCheckpoint(checkpoint)).rejects.toThrow()
        expect(convert).not.toHaveBeenCalled()
        expect(target.storage.getImageSpec(1)).toBe(original)
        expect(original.orig.data[0]).toBe(50)
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('keeps old sources and cells on a later source conversion failure', async () => {
    const source = terminal()
    const target = terminal()
    let checkpoint
    try {
      add(source)
      add(source, 100)
      add(target, 50)
      checkpoint = source.storage.captureCheckpoint(1024)
      const old = target.storage.getImageSpec(1)
      const fromRgba = target.backend.fromRgba.bind(target.backend)
      let prepared
      vi.spyOn(target.backend, 'fromRgba')
        .mockImplementationOnce((...args) => {
          prepared = fromRgba(...args)
          return prepared
        })
        .mockImplementationOnce(() => {
          throw new Error('conversion failed')
        })
      await expect(target.storage.restoreCheckpoint(checkpoint)).rejects.toThrow(
        'conversion failed'
      )
      expect(target.storage.getImageSpec(1)).toBe(old)
      expect(old.orig.data[0]).toBe(50)
      expect(prepared.data.byteLength).toBe(0)
      expect(target.core._core.buffers.normal.lines.get(0)._extendedAttrs[0].imageId).toBe(1)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['reset', 'dispose', 'lease disposal', 'resize', 'newer restoration'])(
    'closes prepared browser pixels after %s',
    async (action) => {
      const source = terminal()
      const target = terminal(true)
      const decoder = browserDecoder()
      const replacement = { width: 2, height: 2, close: vi.fn() }
      let checkpoint
      try {
        add(source)
        checkpoint = source.storage.captureCheckpoint(1024)
        const restoring = target.storage.restoreCheckpoint(checkpoint)
        const outcome = expect(restoring).rejects.toThrow()
        if (action === 'lease disposal') {
          checkpoint.dispose()
        } else if (action === 'resize') {
          target.core.resize(21, 10)
        } else if (action === 'newer restoration') {
          createImageBitmap.mockResolvedValueOnce(replacement)
          await target.storage.restoreCheckpoint(checkpoint)
        } else {
          target.addon[action]()
        }
        decoder.finish()
        await outcome
        expect(decoder.bitmap.close).toHaveBeenCalledOnce()
        expect(target.storage._images.size).toBe(action === 'newer restoration' ? 1 : 0)
        expect(replacement.close).not.toHaveBeenCalled()
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('clears old tiles for an authoritative empty component while preserving link and underline attributes', async () => {
    const source = terminal()
    const target = terminal()
    let checkpoint
    try {
      add(target)
      const line = target.core._core.buffers.normal.lines.get(0)
      const attrs = line._extendedAttrs[0]
      attrs.urlId = 123
      attrs.underlineColor = 0x3123456
      checkpoint = source.storage.captureCheckpoint(0)
      await target.storage.restoreCheckpoint(checkpoint)
      expect(target.storage._images.size).toBe(0)
      expect(line._extendedAttrs[0].imageId).toBe(-1)
      expect(line._extendedAttrs[0].tileId).toBe(-1)
      expect(line._extendedAttrs[0].urlId).toBe(123)
      expect(line._extendedAttrs[0].underlineColor).toBe(0x3123456)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('preserves evicted-image placeholder cells without restoring their pixels', async () => {
    const source = terminal()
    const target = terminal()
    let checkpoint
    try {
      add(source)
      source.storage.deleteImage(1)
      checkpoint = source.storage.captureCheckpoint(1024)
      expect(checkpoint.metadata.images).toHaveLength(0)
      expect(checkpoint.metadata.byteLength).toBe(32)
      await target.storage.restoreCheckpoint(checkpoint)
      expect(target.storage._images.size).toBe(0)
      expect(target.core._core.buffers.normal.lines.get(0)._extendedAttrs[0]?.imageId ?? -1).toBe(1)
      expect(target.core._core.buffers.normal.lines.get(0)._extendedAttrs[0]?.tileId).toBe(0)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('disposes old markers before reusing an internal image ID', async () => {
    const source = terminal()
    const target = terminal()
    let checkpoint
    try {
      add(source)
      add(target, 50)
      const old = target.storage.getImageSpec(1)
      checkpoint = source.storage.captureCheckpoint(1024)
      await target.storage.restoreCheckpoint(checkpoint)
      const restored = target.storage.getImageSpec(1)
      expect(old.marker.isDisposed).toBe(true)
      expect(old.orig.data.byteLength).toBe(0)
      expect(restored.orig.data[0]).toBe(255)
      restored.marker.dispose()
      expect(target.storage._images.size).toBe(0)
      expect(restored.orig.data.byteLength).toBe(0)
    } finally {
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })
})
