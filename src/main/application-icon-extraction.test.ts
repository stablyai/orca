import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getFileIconMock, createThumbnailMock, createFromBufferMock } = vi.hoisted(() => ({
  getFileIconMock: vi.fn(),
  createThumbnailMock: vi.fn(),
  createFromBufferMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getFileIcon: getFileIconMock },
  nativeImage: {
    createThumbnailFromPath: createThumbnailMock,
    createFromBuffer: createFromBufferMock
  }
}))

const { applicationLabelFromPath, applicationPickerOptions, extractApplicationIcon } =
  await import('./application-icon-extraction')

type FakeIconOptions = {
  width: number
  height: number
  empty?: boolean
  png?: Buffer
  scaleFactors?: number[]
  /** Transparent margin, in pixels, on every side. */
  margin?: number
  onResize?: (size: Record<string, unknown>) => void
  onCrop?: (rect: Record<string, unknown>) => void
}

function fakeIcon(options: FakeIconOptions): unknown {
  const { width, height, margin = 0 } = options
  const image = {
    isEmpty: () => options.empty === true,
    getSize: () => ({ width, height }),
    getScaleFactors: () => options.scaleFactors ?? [1],
    toPNG: () => options.png ?? Buffer.from(`icon-${width}x${height}`),
    toDataURL: () =>
      `data:image/png;base64,${(options.png ?? Buffer.from(`icon-${width}x${height}`)).toString('base64')}`,
    toBitmap: () => {
      const bitmap = Buffer.alloc(width * height * 4)
      for (let y = margin; y < height - margin; y += 1) {
        for (let x = margin; x < width - margin; x += 1) {
          bitmap[(y * width + x) * 4 + 3] = 255
        }
      }
      return bitmap
    },
    crop: (rect: { width: number; height: number } & Record<string, unknown>) => {
      options.onCrop?.(rect)
      return fakeIcon({ ...options, width: rect.width, height: rect.height, margin: 0 })
    },
    resize: (size: Record<string, unknown>) => {
      options.onResize?.(size)
      return fakeIcon({
        ...options,
        width: Number(size.width ?? width),
        height: Number(size.height ?? height),
        margin: 0
      })
    }
  }
  return image
}

beforeEach(() => {
  getFileIconMock.mockReset()
  createThumbnailMock.mockReset()
  createFromBufferMock.mockReset()
  createThumbnailMock.mockResolvedValue(fakeIcon({ width: 64, height: 64 }))
  createFromBufferMock.mockImplementation(() => fakeIcon({ width: 128, height: 128 }))
})

describe('applicationPickerOptions', () => {
  it('filters to what counts as an application on each platform', () => {
    expect(applicationPickerOptions('darwin').filters?.[0].extensions).toEqual(['app'])
    expect(applicationPickerOptions('win32').filters?.[0].extensions).toContain('exe')
    // Why: Linux installs land in too many shapes to filter strictly, so an
    // all-files fallback keeps the picker usable there.
    expect(applicationPickerOptions('linux').filters?.at(-1)?.extensions).toEqual(['*'])
  })

  it('opens macOS at the folder the apps actually live in', () => {
    expect(applicationPickerOptions('darwin').defaultPath).toBe('/Applications')
    expect(applicationPickerOptions('darwin').properties).not.toContain('treatPackageAsDirectory')
  })
})

describe('extractApplicationIcon', () => {
  it("reads the bundle's own icon rather than its generic type icon", async () => {
    await extractApplicationIcon('/Applications/IntelliJ IDEA.app')

    expect(createThumbnailMock).toHaveBeenCalledWith('/Applications/IntelliJ IDEA.app', {
      width: 64,
      height: 64
    })
    expect(getFileIconMock).not.toHaveBeenCalled()
  })

  it('falls back to the type icon where no thumbnailer exists', async () => {
    createThumbnailMock.mockRejectedValue(new Error('not supported'))
    getFileIconMock.mockResolvedValue(fakeIcon({ width: 32, height: 32 }))

    const picked = await extractApplicationIcon('/usr/share/applications/zed.desktop')

    expect(picked.dataUrl).toContain('base64,')
    // Why: 'large' aborts the macOS main process outright, so pin the one safe size.
    expect(getFileIconMock.mock.calls[0][1].size).toBe('normal')
  })

  it('trims the transparent margin so a padded tile is not rendered smaller', async () => {
    const crops: Record<string, unknown>[] = []
    createThumbnailMock.mockResolvedValue(fakeIcon({ width: 64, height: 64, scaleFactors: [1, 2] }))
    createFromBufferMock.mockImplementation(() =>
      fakeIcon({ width: 128, height: 128, margin: 20, onCrop: (rect) => crops.push(rect) })
    )

    await extractApplicationIcon('/Applications/Android Studio.app')

    expect(crops).toEqual([{ x: 20, y: 20, width: 88, height: 88 }])
  })

  it('leaves an edge-to-edge mark uncropped', async () => {
    const crops: Record<string, unknown>[] = []
    createThumbnailMock.mockResolvedValue(fakeIcon({ width: 64, height: 64, scaleFactors: [1, 2] }))
    createFromBufferMock.mockImplementation(() =>
      fakeIcon({ width: 128, height: 128, margin: 0, onCrop: (rect) => crops.push(rect) })
    )

    await extractApplicationIcon('/Applications/Visual Studio Code.app')

    expect(crops).toEqual([])
  })

  it('trims the sharpest representation, not the 1x one', async () => {
    createThumbnailMock.mockResolvedValue(fakeIcon({ width: 64, height: 64, scaleFactors: [1, 2] }))

    await extractApplicationIcon('/Applications/Android Studio.app')

    // Why: crop() keeps only the 1x rep, so trimming before flattening would halve
    // the resolution of every padded icon.
    expect(createFromBufferMock).toHaveBeenCalled()
  })

  it('downscales an oversized icon along one axis to keep its aspect ratio', async () => {
    const resizes: Record<string, unknown>[] = []
    createThumbnailMock.mockResolvedValue(
      fakeIcon({ width: 256, height: 200, scaleFactors: [1, 2] })
    )
    createFromBufferMock.mockImplementation(() =>
      fakeIcon({ width: 256, height: 200, onResize: (size) => resizes.push(size) })
    )

    await extractApplicationIcon('/Applications/Huge.app')

    expect(resizes).toEqual([{ width: 64, quality: 'best' }])
  })

  it('keeps a small system icon at its native size instead of upscaling it', async () => {
    const resizes: Record<string, unknown>[] = []
    createThumbnailMock.mockResolvedValue(
      fakeIcon({ width: 32, height: 32, onResize: (size) => resizes.push(size) })
    )

    await extractApplicationIcon('/usr/share/applications/zed.desktop')

    expect(resizes).toEqual([])
  })

  it('fails loudly when the file carries no icon', async () => {
    createThumbnailMock.mockResolvedValue(fakeIcon({ width: 0, height: 0, empty: true }))

    await expect(extractApplicationIcon('/tmp/not-an-app')).rejects.toThrow(
      'Could not read an icon'
    )
  })

  it('rejects an icon too large to store in settings', async () => {
    createThumbnailMock.mockResolvedValue(
      fakeIcon({ width: 64, height: 64, png: Buffer.alloc(128 * 1024, 1) })
    )

    await expect(extractApplicationIcon('/Applications/Huge.app')).rejects.toThrow('too large')
  })
})

describe('applicationLabelFromPath', () => {
  it('names the row after the app, without its extension', () => {
    expect(applicationLabelFromPath('/Applications/IntelliJ IDEA.app')).toBe('IntelliJ IDEA')
    expect(applicationLabelFromPath('/usr/share/applications/zed.desktop')).toBe('zed')
  })
})
