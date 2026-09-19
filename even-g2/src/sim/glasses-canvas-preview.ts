// Unit 6: paints a MockGlassesBridge page onto a 576x288 canvas (x2 CSS scale) approximating
// the G2's 4-bit green-on-black display (spec S4/S9). `describePage` is the pure half of this
// module — no canvas required — so tests can assert rendered content without a DOM canvas.
import type { HudPageBuild } from '../glasses/glasses-bridge'

export const GLASSES_WIDTH = 576
export const GLASSES_HEIGHT = 288
const CSS_SCALE = 2

// Approximate 4-step green brightness ramp toward the documented #3ba03b.
const GREEN_LEVELS = ['#123312', '#1f551f', '#2d7a2d', '#3ba03b'] as const

export type GlassesCanvasPaintOptions = {
  /** Selected row index for the page's event-capture list container, if any. */
  listSelectedIndex?: number
}

/** Text rows a page would show, in container order. Pure — usable in node tests. */
export function describePage(page: HudPageBuild, opts?: GlassesCanvasPaintOptions): string[] {
  const rows: string[] = []
  for (const container of page.containers) {
    if (container.kind === 'text') {
      rows.push(...container.content.split('\n'))
      continue
    }
    container.items.forEach((item, index) => {
      const cursor = opts?.listSelectedIndex === index ? '> ' : '  '
      rows.push(`${cursor}${item}`)
    })
  }
  return rows
}

function brightnessLevel(value: number | undefined): (typeof GREEN_LEVELS)[number] {
  if (value === undefined) {
    return GREEN_LEVELS[3]
  }
  const clamped = Math.max(0, Math.min(16, value))
  const index = Math.min(3, Math.floor((clamped / 16) * 4))
  return GREEN_LEVELS[index] ?? GREEN_LEVELS[3]
}

/** Blanks the canvas to the display's off state — used when there's no HUD page to show (e.g.
 *  after a hard shutdown / confirmed exit) so the sim doesn't keep showing a stale frame. */
export function clearHudCanvas(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, GLASSES_WIDTH, GLASSES_HEIGHT)
}

/** Paints one page onto a 2D context sized GLASSES_WIDTH x GLASSES_HEIGHT. */
export function paintHudPage(
  ctx: CanvasRenderingContext2D,
  page: HudPageBuild,
  opts?: GlassesCanvasPaintOptions
): void {
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, GLASSES_WIDTH, GLASSES_HEIGHT)
  ctx.textBaseline = 'top'
  ctx.font = '20px sans-serif' // proportional approximation of the LVGL font

  for (const container of page.containers) {
    if (container.borderWidth) {
      ctx.strokeStyle = brightnessLevel(container.borderColor)
      ctx.lineWidth = container.borderWidth
      ctx.strokeRect(container.x, container.y, container.width, container.height)
    }

    const lineHeight = 24
    const padding = container.paddingLength ?? 4

    if (container.kind === 'text') {
      ctx.fillStyle = GREEN_LEVELS[3]
      container.content.split('\n').forEach((line, i) => {
        ctx.fillText(line, container.x + padding, container.y + padding + i * lineHeight)
      })
      continue
    }

    container.items.forEach((item, index) => {
      const rowY = container.y + padding + index * lineHeight
      if (index === opts?.listSelectedIndex && container.showSelectionBorder) {
        ctx.fillStyle = GREEN_LEVELS[0]
        ctx.fillRect(container.x, rowY - 2, container.width, lineHeight)
      }
      ctx.fillStyle = GREEN_LEVELS[3]
      const cursor = index === opts?.listSelectedIndex ? '> ' : '  '
      ctx.fillText(`${cursor}${item}`, container.x + padding, rowY)
    })
  }
}

export type GlassesCanvasPreview = {
  canvas: HTMLCanvasElement
  paint: (page: HudPageBuild, opts?: GlassesCanvasPaintOptions) => void
  /** Blanks the preview — call when there's no HUD page to show. */
  clear: () => void
}

/**
 * Mounts a scaled canvas into `container` and returns a paint() closure. Returns null when
 * a real 2D canvas context isn't available (node/happy-dom test environments) so callers can
 * skip visual rendering without special-casing every environment.
 */
export function createGlassesCanvasPreview(container: HTMLElement): GlassesCanvasPreview | null {
  const canvas = document.createElement('canvas')
  canvas.width = GLASSES_WIDTH
  canvas.height = GLASSES_HEIGHT
  canvas.style.width = `${GLASSES_WIDTH * CSS_SCALE}px`
  canvas.style.height = `${GLASSES_HEIGHT * CSS_SCALE}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }
  container.appendChild(canvas)
  return {
    canvas,
    paint: (page, opts) => paintHudPage(ctx, page, opts),
    clear: () => clearHudCanvas(ctx)
  }
}
