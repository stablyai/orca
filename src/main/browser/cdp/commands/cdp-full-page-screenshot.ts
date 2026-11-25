import { nativeImage, type NativeImage, type WebContents } from 'electron'
import type { CapturePaintHold } from '../debugger/guest-paint-hold'
import type { CaptureViewport } from './cdp-capture-scale'
import {
  captureUntilDrawn,
  measureCaptureViewport,
  SCREENSHOT_TIMEOUT_MESSAGE
} from './cdp-screenshot'

// Bounds the bitmap stitched in main; 16384 is also Chromium's largest texture edge.
const MAX_FULL_PAGE_EDGE_PX = 16_384
// Stitching and encoding run on main: 32 MP is roughly 150 ms of work and a 128 MB canvas.
const MAX_FULL_PAGE_PIXELS = 32 * 1024 * 1024
// Each tile is a capture of its own; keeps a long page in a small pane under the CLI's timeout.
const MAX_FULL_PAGE_TILES = 32
// Stops issuing tiles in time for one last tile to finish before the CLI's 60-second request timeout.
const FULL_PAGE_TIMEOUT_MS = 45_000

/** CSS pixels a tile asks for, and the device pixels it fills in the stitched image. */
type Span = { start: number; length: number; offset: number; size: number }

type FullPageTilePlan = { scale: number; columns: Span[]; rows: Span[] }

function spans(total: number, step: number, pixelsPerCssPixel: number): Span[] {
  // Each tile overlaps the next by one CSS pixel, so its rounded edge never leaves a gap.
  const advance = Math.max(1, Math.floor(step) - 1)
  const edge = (css: number): number => Math.round(css * pixelsPerCssPixel)
  const out: Span[] = []
  for (let start = 0; ; start += advance) {
    const length = Math.min(advance + 1, total - start)
    const last = start + length >= total
    out.push({
      start,
      length,
      offset: edge(start),
      size: edge(last ? total : start + advance) - edge(start)
    })
    if (last) {
      break
    }
  }
  return out
}

/** Tiles whose images fit the drawn surface: a webview guest draws only its pane, so a taller clip repeats it. */
export function planFullPageTiles(viewport: CaptureViewport): FullPageTilePlan {
  const { contentWidth, contentHeight, surface } = viewport
  const imageWidth = contentWidth * viewport.pixelsPerCssPixel
  const imageHeight = contentHeight * viewport.pixelsPerCssPixel
  let shrink = Math.min(
    1,
    MAX_FULL_PAGE_EDGE_PX / imageWidth,
    MAX_FULL_PAGE_EDGE_PX / imageHeight,
    Math.sqrt(MAX_FULL_PAGE_PIXELS / (imageWidth * imageHeight))
  )
  for (;;) {
    const pixelsPerCssPixel = viewport.pixelsPerCssPixel * shrink
    const plan = {
      scale: viewport.scale * shrink,
      columns: spans(
        contentWidth,
        surface ? surface.width / pixelsPerCssPixel : viewport.viewport.width,
        pixelsPerCssPixel
      ),
      rows: spans(
        contentHeight,
        surface ? surface.height / pixelsPerCssPixel : viewport.viewport.height,
        pixelsPerCssPixel
      )
    }
    const tiles = plan.columns.length * plan.rows.length
    // Without a surface the tiles stay viewport-sized whatever the scale, so shrinking cannot help.
    if (tiles <= MAX_FULL_PAGE_TILES || !surface) {
      return plan
    }
    shrink *= Math.sqrt(MAX_FULL_PAGE_TILES / tiles) * 0.99
  }
}

/** Places each tile at its planned pixel offset; a tile a pixel short repeats its edge. */
function stitchTiles(plan: FullPageTilePlan, tiles: NativeImage[][]): NativeImage {
  const width = plan.columns.reduce((sum, column) => sum + column.size, 0)
  const height = plan.rows.reduce((sum, row) => sum + row.size, 0)
  const canvas = Buffer.alloc(width * height * 4)
  plan.rows.forEach((row, rowIndex) => {
    plan.columns.forEach((column, columnIndex) => {
      const tile = tiles[rowIndex][columnIndex]
      const { width: tileWidth, height: tileHeight } = tile.getSize()
      const bitmap = tile.toBitmap()
      const copyWidth = Math.min(column.size, tileWidth)
      for (let line = 0; line < row.size; line++) {
        const source = Math.min(line, tileHeight - 1) * tileWidth * 4
        const target = ((row.offset + line) * width + column.offset) * 4
        bitmap.copy(canvas, target, source, source + copyWidth * 4)
        for (let pixel = copyWidth; pixel < column.size; pixel++) {
          bitmap.copy(
            canvas,
            target + pixel * 4,
            source + (copyWidth - 1) * 4,
            source + copyWidth * 4
          )
        }
      }
    })
  })
  return nativeImage.createFromBitmap(canvas, { width, height })
}

export async function captureFullPageScreenshot(
  webContents: WebContents,
  format: 'png' | 'jpeg',
  holdPaint: CapturePaintHold
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  if (webContents.isDestroyed()) {
    throw new Error('WebContents destroyed')
  }
  if (!webContents.debugger.isAttached()) {
    throw new Error('Debugger not attached')
  }

  const release = holdPaint()
  try {
    const viewport = await measureCaptureViewport(webContents)
    if (!viewport) {
      throw new Error('Unable to determine full-page screenshot bounds')
    }
    const plan = planFullPageTiles(viewport)
    if (
      plan.columns.every((column) => column.size === 0) ||
      plan.rows.every((row) => row.size === 0)
    ) {
      throw new Error('The page is too large to capture as one image.')
    }
    const deadline = Date.now() + FULL_PAGE_TIMEOUT_MS
    const single = plan.rows.length === 1 && plan.columns.length === 1
    const tiles: NativeImage[][] = []
    // Sequential: a capture sent while a clipped one is pending leaves its emulation applied.
    for (const row of plan.rows) {
      const tileRow: NativeImage[] = []
      for (const column of plan.columns) {
        if (Date.now() > deadline) {
          throw new Error(SCREENSHOT_TIMEOUT_MESSAGE)
        }
        const frame = await captureUntilDrawn(
          webContents,
          {
            format: single ? format : 'png',
            captureBeyondViewport: true,
            clip: {
              x: column.start,
              y: row.start,
              width: column.length,
              height: row.length,
              scale: plan.scale
            }
          },
          holdPaint
        )
        if (!frame) {
          throw new Error(SCREENSHOT_TIMEOUT_MESSAGE)
        }
        if (single) {
          return { data: frame.data, format }
        }
        tileRow.push(nativeImage.createFromBuffer(Buffer.from(frame.data, 'base64')))
      }
      tiles.push(tileRow)
    }
    const page = stitchTiles(plan, tiles)
    const encoded = format === 'jpeg' ? page.toJPEG(90) : page.toPNG()
    return { data: encoded.toString('base64'), format }
  } finally {
    release()
  }
}
