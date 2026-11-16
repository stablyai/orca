import {
  THEME_GLASS_BLUR_PX,
  THEME_GLASS_SAMPLE_COLUMNS,
  THEME_GLASS_SAMPLE_ROWS,
  type ThemeGlassBlurRequest,
  type ThemeGlassBlurResult
} from './theme-glass-blur-protocol'

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('no 2d context')
  }
  return ctx
}

/** Each grid cell's darkest and brightest pixel, so a small bright or dark patch still counts. */
function extremes(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(THEME_GLASS_SAMPLE_COLUMNS * THEME_GLASS_SAMPLE_ROWS * 8)
  for (let row = 0; row < THEME_GLASS_SAMPLE_ROWS; row += 1) {
    for (let column = 0; column < THEME_GLASS_SAMPLE_COLUMNS; column += 1) {
      let darkest = -1
      let brightest = -1
      let low = Infinity
      let high = -Infinity
      const y0 = Math.floor((row * height) / THEME_GLASS_SAMPLE_ROWS)
      const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * height) / THEME_GLASS_SAMPLE_ROWS))
      const x0 = Math.floor((column * width) / THEME_GLASS_SAMPLE_COLUMNS)
      const x1 = Math.max(x0 + 1, Math.floor(((column + 1) * width) / THEME_GLASS_SAMPLE_COLUMNS))
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 4
          const light = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722
          if (light < low) {
            low = light
            darkest = i
          }
          if (light > high) {
            high = light
            brightest = i
          }
        }
      }
      const cell = (row * THEME_GLASS_SAMPLE_COLUMNS + column) * 8
      out.set(pixels.subarray(darkest, darkest + 4), cell)
      out.set(pixels.subarray(brightest, brightest + 4), cell + 4)
    }
  }
  return out
}

/** Blurs the already reduced image and samples it for the contrast check. */
self.onmessage = async (event: MessageEvent<ThemeGlassBlurRequest>): Promise<void> => {
  const { bitmap, tile } = event.data
  try {
    const { width, height } = bitmap
    // Why a padded source: the blur reads past the edges, which would otherwise fade to transparent.
    // A tile wraps to its opposite edges so repeats blur into each other; others stretch outward.
    const pad = THEME_GLASS_BLUR_PX * 2
    const source = new OffscreenCanvas(width + pad * 2, height + pad * 2)
    const sourceCtx = context(source)
    if (tile) {
      for (const dy of [-1, 0, 1]) {
        for (const dx of [-1, 0, 1]) {
          sourceCtx.drawImage(bitmap, pad + dx * width, pad + dy * height, width, height)
        }
      }
    } else {
      sourceCtx.drawImage(bitmap, 0, 0, source.width, source.height)
      sourceCtx.drawImage(bitmap, pad, pad, width, height)
    }
    bitmap.close()

    const blurred = new OffscreenCanvas(width, height)
    const blurredCtx = context(blurred)
    blurredCtx.filter = `blur(${THEME_GLASS_BLUR_PX}px)`
    blurredCtx.drawImage(source, -pad, -pad)
    const samples = extremes(blurredCtx.getImageData(0, 0, width, height).data, width, height)

    const blob = await blurred.convertToBlob({ type: 'image/webp', quality: 0.9 })
    const result: ThemeGlassBlurResult = { ok: true, blob, samples }
    self.postMessage(result, { transfer: [samples.buffer] })
  } catch (error) {
    bitmap.close()
    const result: ThemeGlassBlurResult = { ok: false, error: String(error) }
    self.postMessage(result)
  }
}
