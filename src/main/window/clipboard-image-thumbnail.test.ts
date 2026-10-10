import { describe, expect, it, vi } from 'vitest'
import { buildClipboardImageThumbnail } from './clipboard-image-thumbnail'

function fakeImage(overrides: Partial<Parameters<typeof buildClipboardImageThumbnail>[0]>) {
  return {
    isEmpty: () => false,
    getSize: () => ({ height: 10, width: 10 }),
    resize: vi.fn(() => ({ toDataURL: () => 'data:image/png;base64,SMALL' })),
    toDataURL: () => 'data:image/png;base64,FULL',
    ...overrides
  }
}

describe('buildClipboardImageThumbnail', () => {
  it('downscales to the thumbnail budget but reports the source dimensions', () => {
    const image = fakeImage({ getSize: () => ({ height: 1600, width: 3200 }) })

    expect(buildClipboardImageThumbnail(image)).toEqual({
      dataUrl: 'data:image/png;base64,SMALL',
      height: 1600,
      width: 3200
    })
    expect(image.resize).toHaveBeenCalledWith({ height: 160, quality: 'good', width: 320 })
  })

  it('skips the resize for an image that already fits', () => {
    const image = fakeImage({ getSize: () => ({ height: 200, width: 320 }) })

    expect(buildClipboardImageThumbnail(image)?.dataUrl).toBe('data:image/png;base64,FULL')
    expect(image.resize).not.toHaveBeenCalled()
  })

  it('reports no thumbnail for an empty clipboard so text paste falls through', () => {
    expect(buildClipboardImageThumbnail(fakeImage({ isEmpty: () => true }))).toBeNull()
  })

  it('reports no thumbnail rather than throwing for an oversized image', () => {
    // The save call still surfaces the real too-large error; the probe only
    // decides whether a placeholder chip is worth showing.
    const image = fakeImage({ getSize: () => ({ height: 100_000, width: 100_000 }) })

    expect(buildClipboardImageThumbnail(image)).toBeNull()
    expect(image.resize).not.toHaveBeenCalled()
  })
})
