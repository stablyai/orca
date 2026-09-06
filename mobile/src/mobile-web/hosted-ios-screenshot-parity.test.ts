import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { assertHostedIosScreenshotParity } from '../../scripts/hosted-ios-screenshot-parity.mjs'

describe('hosted iOS screenshot parity', () => {
  it('masks status-bar changes while enforcing the shared content surface', async () => {
    const native = createScreenshot(100, 100)
    const hosted = createScreenshot(100, 100)
    paintRows(hosted, 0, 6, 255)
    const paths = await writeScreenshots(native, hosted)

    const result = await assertHostedIosScreenshotParity({
      ...paths,
      nativeLandmark: { x: 0.5, y: 0.1 },
      hostedLandmark: { x: 0.7, y: 0.104 }
    })
    expect(result.changedPixelRatio).toBe(0)
    expect(result.landmarkDelta.x).toBeCloseTo(0.2)
    expect(result.landmarkDelta.y).toBeCloseTo(0.004)
  })

  it('rejects a material change below the status bar', async () => {
    const native = createScreenshot(100, 100)
    const hosted = createScreenshot(100, 100)
    paintRows(hosted, 20, 40, 255)
    const paths = await writeScreenshots(native, hosted)

    await expect(
      assertHostedIosScreenshotParity({
        ...paths,
        nativeLandmark: { x: 0.5, y: 0.1 },
        hostedLandmark: { x: 0.5, y: 0.1 }
      })
    ).rejects.toThrow('exceeded parity budgets')
  })

  it('tolerates local text-rasterization shifts without hiding the raw difference', async () => {
    const native = createScreenshot(200, 200)
    const hosted = createScreenshot(200, 200)
    paintVerticalStripes(native, 20, 0)
    paintVerticalStripes(hosted, 20, 4)
    const paths = await writeScreenshots(native, hosted)

    const result = await assertHostedIosScreenshotParity({
      ...paths,
      nativeLandmark: { x: 0.5, y: 0.1 },
      hostedLandmark: { x: 0.5, y: 0.1 }
    })
    expect(result.rawChangedPixelRatio).toBeGreaterThan(0.1)
    expect(result.changedPixelRatio).toBe(0)
    expect(result.neighborhoodRadiusPixels).toBe(16)
  })

  it('rejects a safe-area landmark shift even when the pixels match', async () => {
    const screenshot = createScreenshot(100, 100)
    const paths = await writeScreenshots(screenshot, screenshot)

    await expect(
      assertHostedIosScreenshotParity({
        ...paths,
        nativeLandmark: { x: 0.5, y: 0.1 },
        hostedLandmark: { x: 0.5, y: 0.11 }
      })
    ).rejects.toThrow('exceeded parity budgets')
  })

  it('supports pixel-only evidence when rotated WebView accessibility is unavailable', async () => {
    const screenshot = createScreenshot(100, 100)
    const paths = await writeScreenshots(screenshot, screenshot)

    await expect(
      assertHostedIosScreenshotParity({
        ...paths,
        nativeLandmark: null,
        hostedLandmark: null
      })
    ).resolves.toMatchObject({ changedPixelRatio: 0, landmarkDelta: null })
  })
})

function createScreenshot(width: number, height: number) {
  const png = new PNG({ width, height })
  png.data.fill(0)
  return png
}

function paintRows(png: PNG, firstRow: number, lastRow: number, value: number) {
  for (let y = firstRow; y <= lastRow; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4
      png.data[offset] = value
      png.data[offset + 1] = value
      png.data[offset + 2] = value
      png.data[offset + 3] = 255
    }
  }
}

function paintVerticalStripes(png: PNG, firstRow: number, xOffset: number) {
  for (let x = xOffset; x < png.width; x += 12) {
    for (let y = firstRow; y < png.height; y++) {
      paintPixel(png, x, y, 255)
      paintPixel(png, x + 1, y, 128)
    }
  }
}

function paintPixel(png: PNG, x: number, y: number, value: number) {
  if (x >= png.width) {
    return
  }
  const offset = (y * png.width + x) * 4
  png.data[offset] = value
  png.data[offset + 1] = value
  png.data[offset + 2] = value
  png.data[offset + 3] = 255
}

async function writeScreenshots(native: PNG, hosted: PNG) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-hosted-ios-parity-'))
  const nativeScreenshot = path.join(directory, 'native.png')
  const hostedScreenshot = path.join(directory, 'hosted.png')
  await Promise.all([
    writeFile(nativeScreenshot, PNG.sync.write(native)),
    writeFile(hostedScreenshot, PNG.sync.write(hosted))
  ])
  return { nativeScreenshot, hostedScreenshot }
}
