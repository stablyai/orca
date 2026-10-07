import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'
import { releaseTerminalRasterDecoder } from '../../src/shared/terminal-raster-wasm-decoder'

afterEach(releaseTerminalRasterDecoder)

const pixels = Buffer.alloc(16 * 12 * 4, 255)
const image = `\x1b_Ga=T,f=32,s=16,v=12,i=7,q=2;${pixels.toString('base64')}\x1b\\`
const write = (h, data) => h.core._core.writeSync(data)

function tileCells(h, type) {
  const buffer = type === 'normal' ? h.core._core.buffers.normal : h.core._core.buffers.alt
  return Array.from({ length: buffer.lines.length }, (_, row) => {
    const line = buffer.lines.get(row)
    return Array.from({ length: line.length }, (_, col) => {
      const attrs = line.getBg(col) & 0x10000000 ? line._extendedAttrs[col] : undefined
      return [attrs?.imageId ?? -1, attrs?.tileId ?? -1]
    })
  })
}

describe('checkpoint tiles whose decoded image has been retired', () => {
  it.each(['normal', 'alternate'])(
    'preserves the live placeholder cells in the %s buffer after Kitty replacement',
    async (type) => {
      const source = terminal()
      const target = terminal()
      let checkpoint
      try {
        if (type === 'alternate') {
          write(source, '\x1b[?1049h')
        }
        write(source, `\x1b[2;3H${image}\x1b[5;3H${image}`)
        expect([...source.storage._images.keys()]).toEqual([2])
        const expected = tileCells(source, type)
        expect(expected.flat().some(([id]) => id === 1)).toBe(true)
        const text = source.serializer.serialize()
        checkpoint = source.storage.captureCheckpoint(1024 * 1024)
        source.core.dispose()
        write(target, text)
        await target.storage.restoreCheckpoint(checkpoint)
        expect(tileCells(target, type)).toEqual(expected)
        expect([...target.storage._images.keys()]).toEqual([2])
        expect(target.storage._lastId).toBe(2)
        write(
          target,
          `\x1b[8;3H\x1b_Ga=T,f=32,s=2,v=2,i=7,q=2;${Buffer.alloc(16, 255).toString('base64')}\x1b\\`
        )
        expect(target.storage._lastId).toBe(3)
        expect(
          tileCells(target, type)
            .flat()
            .some(([id]) => id === 1)
        ).toBe(true)
      } finally {
        checkpoint?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('retains placeholders without allocating replacement pixels when no images remain', async () => {
    const source = terminal()
    const target = terminal()
    let checkpoint
    try {
      write(source, image)
      source.storage._delImg(1)
      const expected = tileCells(source, 'normal')
      expect(expected.flat().some(([id]) => id === 1)).toBe(true)
      expect(() => source.storage.captureCheckpoint(0)).toThrow(/budget/i)
      checkpoint = source.storage.captureCheckpoint(1024)
      expect(checkpoint.metadata.images).toEqual([])
      expect(checkpoint.metadata.byteLength).toBeGreaterThan(0)
      write(target, source.serializer.serialize())
      const allocate = vi.spyOn(target.backend, 'fromRgba')
      await target.storage.restoreCheckpoint(checkpoint)
      expect(allocate).not.toHaveBeenCalled()
      expect(target.storage._images.size).toBe(0)
      expect(tileCells(target, 'normal')).toEqual(expected)
      target.core.reset()
      expect(
        tileCells(target, 'normal')
          .flat()
          .every(([id]) => id === -1)
      ).toBe(true)
    } finally {
      vi.restoreAllMocks()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([
    ['future image ID', (view) => view.setFloat64(12, 3, true)],
    ['fractional image ID', (view) => view.setFloat64(12, 0.5, true)],
    ['negative image ID', (view) => view.setFloat64(12, -1, true)],
    ['nonfinite image ID', (view) => view.setFloat64(12, Number.NaN, true)],
    ['fractional tile ID', (view) => view.setFloat64(20, 0.5, true)],
    ['overflowing tile end', (view) => view.setFloat64(20, Number.MAX_SAFE_INTEGER, true)]
  ])('rejects an orphan run with %s before bitmap allocation', async (_name, corrupt) => {
    const source = terminal()
    const target = terminal()
    let checkpoint, wire
    try {
      write(source, `\x1b[2;3H${image}\x1b[5;3H${image}`)
      checkpoint = source.storage.captureCheckpoint(1024 * 1024)
      const metadata = JSON.parse(JSON.stringify(checkpoint.metadata))
      const resources = new Map(
        metadata.resources.map((r) => [r.id, checkpoint.copyResource(r.id, r.byteLength)])
      )
      const bytes = resources.get(metadata.tilesResourceId)
      // The first run names the retired image; it has no source raster to validate against.
      expect(
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(12, true)
      ).toBe(1)
      corrupt(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      wire = new checkpoint.constructor(metadata, resources)
      write(target, source.serializer.serialize())
      const allocate = vi.spyOn(target.backend, 'fromRgba')
      await expect(target.storage.restoreCheckpoint(wire)).rejects.toThrow()
      expect(allocate).not.toHaveBeenCalled()
      expect(target.storage._images.size).toBe(0)
    } finally {
      vi.restoreAllMocks()
      wire?.dispose()
      checkpoint?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })
})
