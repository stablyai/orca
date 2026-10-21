import { describe, expect, it, vi } from 'vitest'
import { createJimp } from '@jimp/core'
import png from '@jimp/js-png'
import jpeg from '@jimp/js-jpeg'
import { buildImageDataUri } from '../../shared/image-data-uri'
import { readRasterImageDimensions } from '../../shared/raster-image-dimensions'
import { buildRuntimeImagePreview } from './runtime-image-preview'

const Image = createJimp({ formats: [png, jpeg] })
vi.mock('./runtime-image-preview-worker', async () => {
  const { shrinkImagePreview } = await import('./runtime-image-preview-codec')
  return { shrinkImagePreviewInWorker: vi.fn(shrinkImagePreview) }
})

async function noisyPng(width = 800, height = 600, alpha = false): Promise<Buffer> {
  const image = new Image({ width, height })
  let seed = 12345
  for (let offset = 0; offset < image.bitmap.data.length; offset++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    image.bitmap.data[offset] = offset % 4 === 3 ? (alpha ? 128 : 255) : seed >>> 24
  }
  return image.getBuffer('image/png')
}

describe('runtime image previews', () => {
  it('keeps an image byte-for-byte when it fits the request budget', async () => {
    const bytes = await noisyPng(32, 24)
    const result = await buildRuntimeImagePreview(bytes, 'image/png', 64 * 1024)
    expect(result).toEqual({
      content: bytes.toString('base64'),
      isImage: true,
      isBinary: true,
      mimeType: 'image/png'
    })
  })

  it('returns an old-client-compatible JPEG under budget without changing the source', async () => {
    const bytes = await noisyPng()
    const original = Buffer.from(bytes)
    const budget = 48 * 1024
    const result = await buildRuntimeImagePreview(bytes, 'image/png', budget)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget)
    expect(result.mimeType).toBe('image/jpeg')
    const decoded = Buffer.from(result.content, 'base64')
    const dimensions = readRasterImageDimensions(decoded)
    expect(dimensions?.width).toBeLessThanOrEqual(800)
    expect(dimensions?.height).toBeLessThanOrEqual(600)
    expect(dimensions!.width / dimensions!.height).toBeCloseTo(4 / 3, 1)
    expect(buildImageDataUri(result.mimeType, result.content)).toContain('data:image/jpeg;base64,')
    expect((await Image.fromBuffer(decoded)).width).toBe(dimensions?.width)
    expect(bytes).toEqual(original)
  }, 15_000)

  it('preserves transparency in a PNG preview', async () => {
    const result = await buildRuntimeImagePreview(
      await noisyPng(400, 300, true),
      'image/png',
      32 * 1024
    )
    expect(result.mimeType).toBe('image/png')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024)
    const image = await Image.fromBuffer(Buffer.from(result.content, 'base64'))
    expect(image.bitmap.data[3]).toBe(128)
  })

  it('does not transform unbudgeted desktop previews', async () => {
    const bytes = await noisyPng(32, 24)
    expect((await buildRuntimeImagePreview(bytes, 'image/png')).content).toBe(
      bytes.toString('base64')
    )
  })

  it('rejects malformed oversized images and impossible output budgets', async () => {
    await expect(buildRuntimeImagePreview(Buffer.alloc(4096), 'image/png', 1024)).rejects.toThrow(
      'file_too_large'
    )
    await expect(
      buildRuntimeImagePreview(await noisyPng(32, 24), 'image/png', 100)
    ).rejects.toThrow('file_too_large')
  })

  it('does not flatten oversized animations or reinterpret unknown formats', async () => {
    await expect(buildRuntimeImagePreview(Buffer.alloc(4096), 'image/gif', 1024)).rejects.toThrow(
      'file_too_large'
    )
  })

  it('rejects interlaced, duplicate-header, animated, and disguised PNGs before decoding', async () => {
    const { shrinkImagePreviewInWorker } = await import('./runtime-image-preview-worker')
    vi.mocked(shrinkImagePreviewInWorker).mockClear()
    const source = await noisyPng(32, 24)
    const interlaced = Buffer.from(source)
    interlaced[28] = 1
    const duplicate = Buffer.concat([source.subarray(0, 33), source.subarray(8)])
    const animated = Buffer.concat([
      source.subarray(0, 33),
      Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]),
      source.subarray(33)
    ])
    for (const bytes of [interlaced, duplicate, animated]) {
      await expect(buildRuntimeImagePreview(bytes, 'image/png', 1024)).rejects.toThrow(
        'file_too_large'
      )
    }
    await expect(buildRuntimeImagePreview(source, 'image/jpeg', 1024)).rejects.toThrow(
      'file_too_large'
    )
    expect(shrinkImagePreviewInWorker).not.toHaveBeenCalled()
  })

  it('shrinks JPEG input and rejects sources above the bounded read ceiling', async () => {
    const image = await Image.fromBuffer(await noisyPng())
    const result = await buildRuntimeImagePreview(
      await image.getBuffer('image/jpeg'),
      'image/jpeg',
      48 * 1024
    )
    expect(result.mimeType).toBe('image/jpeg')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(48 * 1024)
    await expect(
      buildRuntimeImagePreview(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png', 1024)
    ).rejects.toThrow('file_too_large')
  })
})
