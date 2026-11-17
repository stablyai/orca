import { z } from 'zod'

const Size = z.object({ width: z.number().positive(), height: z.number().positive() })

const LayoutMetrics = z.object({
  cssContentSize: Size,
  cssVisualViewport: z.object({
    pageX: z.number(),
    pageY: z.number(),
    clientWidth: z.number().positive(),
    clientHeight: z.number().positive(),
    scale: z.number().positive().optional(),
    zoom: z.number().positive().optional()
  }),
  // Device pixels of the drawn surface; an emulated device scale factor leaves it unchanged.
  visualViewport: z.object({ clientWidth: z.number().positive() }).optional()
})

export type CaptureRect = { x: number; y: number; width: number; height: number }

export type CaptureViewport = {
  /** The visible page area, in CSS pixels of the document. */
  viewport: CaptureRect
  contentWidth: number
  contentHeight: number
  /** `clip.scale` that keeps a viewport-sized capture within the pixels the page really draws. */
  scale: number
  /** Image pixels one CSS pixel becomes at `scale`. */
  pixelsPerCssPixel: number
  /** Device pixels the page really draws; one capture must not ask for more. */
  surface: { width: number; height: number } | null
  /** True when the page's device pixel ratio is emulated and differs from its drawn surface. */
  emulatedDensity: boolean
}

/**
 * Chromium copies a capture out of the page's drawn surface. Asking for more pixels than that
 * surface holds (an emulated device pixel ratio above the real one, or a webview guest's page
 * beyond its pane) wraps the copy, so the page repeats in tiles.
 */
export function readCaptureViewport(
  metrics: unknown,
  devicePixelRatio: number | null
): CaptureViewport | null {
  const parsed = LayoutMetrics.safeParse(metrics)
  if (!parsed.success) {
    return null
  }
  const { cssContentSize, cssVisualViewport: visual, visualViewport } = parsed.data
  const pageScale = visual.scale ?? 1
  const zoom = visual.zoom ?? 1
  const surfaceDensity = visualViewport ? visualViewport.clientWidth / visual.clientWidth : null
  const ratio =
    devicePixelRatio !== null && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : null
  const emulatedDensity =
    ratio !== null && surfaceDensity !== null && Math.abs(ratio - surfaceDensity) > 0.01
  const drawn =
    surfaceDensity === null
      ? null
      : {
          width: visual.clientWidth * pageScale * surfaceDensity,
          height: visual.clientHeight * pageScale * surfaceDensity
        }
  // Whole pixels: a fractional edge can round a request one row past the surface.
  const surface = drawn && { width: Math.floor(drawn.width), height: Math.floor(drawn.height) }
  // clip.scale is multiplied by the emulated ratio (zoom excluded), so divide it back out.
  const scale =
    emulatedDensity && ratio !== null && drawn && surface
      ? ((drawn.width / visual.clientWidth) *
          zoom *
          Math.min(surface.width / drawn.width, surface.height / drawn.height)) /
        ratio
      : 1
  const drawnRatio = ratio ?? surfaceDensity ?? 1
  return {
    viewport: {
      x: visual.pageX,
      y: visual.pageY,
      width: visual.clientWidth,
      height: visual.clientHeight
    },
    contentWidth: Math.ceil(cssContentSize.width),
    contentHeight: Math.ceil(cssContentSize.height),
    scale,
    pixelsPerCssPixel: (scale * drawnRatio) / zoom,
    surface,
    emulatedDensity
  }
}
