import {
  THEME_GLASS_BLUR_PX,
  THEME_GLASS_SAMPLE_COLUMNS,
  THEME_GLASS_SAMPLE_ROWS,
  THEME_GLASS_SCALE,
  type ThemeGlassBlurResult
} from './theme-glass-blur-protocol'

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('no 2d context')
  }
  return ctx
}

self.onmessage = async (event: MessageEvent<ImageBitmap>): Promise<void> => {
  const bitmap = event.data
  try {
    const width = Math.max(1, Math.round(bitmap.width / THEME_GLASS_SCALE))
    const height = Math.max(1, Math.round(bitmap.height / THEME_GLASS_SCALE))
    // Why a padded source: the blur reads past the edges, which would otherwise fade to transparent.
    const pad = THEME_GLASS_BLUR_PX * 2
    const source = new OffscreenCanvas(width + pad * 2, height + pad * 2)
    const sourceCtx = context(source)
    sourceCtx.drawImage(bitmap, 0, 0, source.width, source.height)
    sourceCtx.drawImage(bitmap, pad, pad, width, height)
    bitmap.close()

    const blurred = new OffscreenCanvas(width, height)
    const blurredCtx = context(blurred)
    blurredCtx.filter = `blur(${THEME_GLASS_BLUR_PX}px)`
    blurredCtx.drawImage(source, -pad, -pad)

    const grid = new OffscreenCanvas(THEME_GLASS_SAMPLE_COLUMNS, THEME_GLASS_SAMPLE_ROWS)
    const gridCtx = context(grid)
    gridCtx.drawImage(blurred, 0, 0, grid.width, grid.height)
    const samples = gridCtx.getImageData(0, 0, grid.width, grid.height).data

    const blob = await blurred.convertToBlob({ type: 'image/webp', quality: 0.9 })
    const result: ThemeGlassBlurResult = { ok: true, blob, samples }
    self.postMessage(result, { transfer: [samples.buffer] })
  } catch (error) {
    bitmap.close()
    const result: ThemeGlassBlurResult = { ok: false, error: String(error) }
    self.postMessage(result)
  }
}
