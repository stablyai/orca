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
const MAX_FULL_PAGE_PIXELS = 64 * 1024 * 1024

type Span = { start: number; length: number }

type FullPageTilePlan = { scale: number; columns: Span[]; rows: Span[] }

function spans(total: number, step: number): Span[] {
  const size = Math.max(1, Math.floor(step))
  const out: Span[] = []
  for (let start = 0; start < total; start += size) {
    out.push({ start, length: Math.min(size, total - start) })
  }
  return out
}

/** Tiles whose images fit the drawn surface: a webview guest draws only its pane, so a taller clip repeats it. */
export function planFullPageTiles(viewport: CaptureViewport): FullPageTilePlan {
  const { contentWidth, contentHeight, surface } = viewport
  const imageWidth = contentWidth * viewport.pixelsPerCssPixel
  const imageHeight = contentHeight * viewport.pixelsPerCssPixel
  const shrink = Math.min(
    1,
    MAX_FULL_PAGE_EDGE_PX / imageWidth,
    MAX_FULL_PAGE_EDGE_PX / imageHeight,
    Math.sqrt(MAX_FULL_PAGE_PIXELS / (imageWidth * imageHeight))
  )
  const pixelsPerCssPixel = viewport.pixelsPerCssPixel * shrink
  const tileWidth = surface ? surface.width / pixelsPerCssPixel : viewport.viewport.width
  const tileHeight = surface ? surface.height / pixelsPerCssPixel : viewport.viewport.height
  return {
    scale: viewport.scale * shrink,
    columns: spans(contentWidth, tileWidth),
    rows: spans(contentHeight, tileHeight)
  }
}

/** Lays tiles out by the sizes Chromium returned so rounding never leaves a gap or seam. */
function stitchTiles(tiles: NativeImage[][]): NativeImage {
  const columnWidths = tiles[0].map((tile) => tile.getSize().width)
  const rowHeights = tiles.map((row) => row[0].getSize().height)
  const width = columnWidths.reduce((sum, value) => sum + value, 0)
  const height = rowHeights.reduce((sum, value) => sum + value, 0)
  const canvas = Buffer.alloc(width * height * 4)
  let top = 0
  tiles.forEach((row, rowIndex) => {
    let left = 0
    row.forEach((tile, columnIndex) => {
      const size = tile.getSize()
      const bitmap = tile.toBitmap()
      const copyWidth = Math.min(size.width, columnWidths[columnIndex]) * 4
      for (let line = 0; line < Math.min(size.height, rowHeights[rowIndex]); line++) {
        const source = line * size.width * 4
        bitmap.copy(canvas, ((top + line) * width + left) * 4, source, source + copyWidth)
      }
      left += columnWidths[columnIndex]
    })
    top += rowHeights[rowIndex]
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
    const single = plan.rows.length === 1 && plan.columns.length === 1
    const tiles: NativeImage[][] = []
    // Sequential: a capture sent while a clipped one is pending leaves its emulation applied.
    for (const row of plan.rows) {
      const tileRow: NativeImage[] = []
      for (const column of plan.columns) {
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
    const page = stitchTiles(tiles)
    const encoded = format === 'jpeg' ? page.toJPEG(90) : page.toPNG()
    return { data: encoded.toString('base64'), format }
  } finally {
    release()
  }
}
