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

  it('reports no thumbnail rather than throwing for an oversized image', () => {
    // Preview only decides placeholder visibility; save still reports the actual oversized-image failure.
    const image = fakeImage({ getSize: () => ({ height: 100_000, width: 100_000 }) })

    expect(buildClipboardImageThumbnail(image)).toBeNull()
    expect(image.resize).not.toHaveBeenCalled()
  })
})
