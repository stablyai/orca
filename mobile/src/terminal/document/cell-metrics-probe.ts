import { TERMINAL_TEXT_SCALES } from '../terminal-text-scales'
import type { TerminalCellMetrics } from '../terminal-cell-metrics'
import type { TerminalDocumentScope } from './document-scope'
import { fontPxForScale } from './text-scaling'

/** xterm's DomMeasureStrategy repeat count. */
const DOM_MEASURE_REPEAT = 32

type CharSize = { width: number; height: number }

/**
 * xterm 6's CharSizeService: canvas `measureText('W')` where the font-box metrics exist, else the
 * width of a 32-W run. Font weight is not part of it, exactly as in xterm.
 */
function createCharMeasure(scope: TerminalDocumentScope): (fontPx: number) => CharSize {
  const family = scope.terminalFontFamily
  try {
    const ctx = new OffscreenCanvas(100, 100).getContext('2d')
    const probe = ctx && ctx.measureText('W')
    if (ctx && probe && 'fontBoundingBoxAscent' in probe && 'fontBoundingBoxDescent' in probe) {
      return (fontPx) => {
        ctx.font = fontPx + 'px ' + family
        const metrics = ctx.measureText('W')
        return {
          width: metrics.width,
          height: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
        }
      }
    }
  } catch {}
  return (fontPx) => {
    const span = document.createElement('span')
    span.textContent = 'W'.repeat(DOM_MEASURE_REPEAT)
    span.style.cssText =
      'display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;' +
      'line-height:normal;white-space:pre;font-kerning:none'
    span.style.fontFamily = family
    span.style.fontSize = fontPx + 'px'
    const parent = scope.root || document.body
    parent.append(span)
    const size = { width: span.offsetWidth / DOM_MEASURE_REPEAT, height: span.offsetHeight }
    span.remove()
    return size
  }
}

/** Whether init will attach the WebGL renderer, which snaps the cell width to device pixels. */
function webglRendererExpected(scope: TerminalDocumentScope) {
  if (typeof WebGL2RenderingContext === 'undefined') {
    return false
  }
  try {
    const addon = scope.createWebglAddon()
    if (!addon) {
      return false
    }
    addon.dispose()
    return true
  } catch {
    return false
  }
}

/**
 * The cell box xterm will lay out at every text-size preset, before any terminal exists: the
 * char measure above, rounded as the renderer rounds it (`WebglRenderer`/`DomRenderer`
 * `_updateDimensions` with lineHeight 1 and letterSpacing 0).
 */
export function measureCellMetrics(scope: TerminalDocumentScope): TerminalCellMetrics[] {
  try {
    const measure = createCharMeasure(scope)
    const dpr = window.devicePixelRatio || 1
    const snapsWidth = webglRendererExpected(scope)
    const entries: TerminalCellMetrics[] = []
    for (const fontScale of TERMINAL_TEXT_SCALES) {
      const char = measure(fontPxForScale(fontScale))
      if (!(char.width > 0 && char.height > 0)) {
        return []
      }
      const deviceWidth = snapsWidth ? Math.floor(char.width * dpr) : char.width * dpr
      entries.push({
        fontScale,
        cellWidth: deviceWidth / dpr,
        cellHeight: Math.ceil(char.height * dpr) / dpr
      })
    }
    return entries
  } catch {
    return []
  }
}

/** The box xterm actually laid out, for the scale it was opened at. */
export function laidOutCellMetrics(scope: TerminalDocumentScope): TerminalCellMetrics[] {
  const core = scope.term && scope.term._core
  const dimensions = core && core._renderService && core._renderService.dimensions
  if (!dimensions || !scope.term) {
    return []
  }
  const { width, height } = dimensions.css.cell
  if (!(width > 0 && height > 0)) {
    return []
  }
  // A text-size change between init and ready leaves a box that belongs to neither scale.
  if (scope.term.options.fontSize !== fontPxForScale(scope.currentTextScale)) {
    return []
  }
  return [{ fontScale: scope.currentTextScale, cellWidth: width, cellHeight: height }]
}
