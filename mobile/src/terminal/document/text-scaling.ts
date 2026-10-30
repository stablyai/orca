import { getCellHeight, getCellWidth } from './cell-metrics'
import { elementInRoot } from './document-host-seams'
import { TERMINAL_TEXT_SCALES } from '../terminal-text-scales'
import type { TerminalDocumentScope } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'
import { applyFitScale } from './fit-scale'
import { fitDimensionsFromCell } from '../terminal-grid-fit'

// Re-init temporarily clears ready; latch prior readiness so width reflow cannot turn a transient error fatal.

// Pinch zoom is transient CSS; release commits a real font preset so the grid reflows and native resizes the PTY.

const BASE_FONT_PX = 13
const MIN_FONT_PX = 6

const TEXT_SCALE_PRESETS: readonly number[] = TERMINAL_TEXT_SCALES

export const MIN_TEXT_SCALE = TEXT_SCALE_PRESETS[0]
export const MAX_TEXT_SCALE = TEXT_SCALE_PRESETS[TEXT_SCALE_PRESETS.length - 1]

export function snapToTextScalePreset(value: number) {
  let best = TEXT_SCALE_PRESETS[0],
    bestDelta = Infinity
  for (let i = 0; i < TEXT_SCALE_PRESETS.length; i++) {
    const delta = Math.abs(TEXT_SCALE_PRESETS[i] - value)
    if (delta < bestDelta) {
      bestDelta = delta
      best = TEXT_SCALE_PRESETS[i]
    }
  }
  return best
}
export function fontPxForScale(scale: number) {
  return Math.max(MIN_FONT_PX, Math.round(BASE_FONT_PX * scale))
}
export function isIOSWebView() {
  if (/iP(ad|hone|od)/.test(navigator.userAgent)) {
    return true
  }
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
// Lead with ui-monospace because iOS WebKit may resolve SF Mono to a proportional fallback.
const TERMINAL_FONT_FALLBACKS =
  '"Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", monospace'

// Why: wide ambiguous mode allocates two cells; CJK UI fonts supply full-em glyphs ahead of Consolas (#9958).
const CJK_AMBIGUOUS_FALLBACKS =
  '"Malgun Gothic", "Microsoft YaHei", "Yu Gothic", "Apple SD Gothic Neo", "PingFang SC", "Hiragino Sans", "Noto Sans CJK KR", "Noto Sans CJK SC", "Noto Sans CJK JP"'

export function terminalFontFamilyForAmbiguousWidth(
  mode: 'narrow' | 'wide' | null | undefined
): string {
  const lead = isIOSWebView() ? 'ui-monospace, ' : '"SF Mono", '
  if (mode === 'wide') {
    return (
      lead +
      '"Menlo", "Monaco", "Cascadia Mono", ' +
      CJK_AMBIGUOUS_FALLBACKS +
      ', "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", monospace'
    )
  }
  return lead + TERMINAL_FONT_FALLBACKS
}

// Wait one frame after changing fontSize for cell metrics, then fit the new grid before native PTY reflow.
export function applyTextScale(scope: TerminalDocumentScope, scale: number) {
  scope.currentTextScale = scale
  if (!scope.term) {
    return
  }
  const px = fontPxForScale(scale)
  if (scope.term.options.fontSize === px) {
    // Fit commits report the drawn row pitch changed by pinch.
    applyFitScale(scope, 'text-scale')
    return
  }
  scope.term.options.fontSize = px
  // Fence by generation; scope.term can already refer to a replacement engine.
  const gen = scope.terminalGeneration
  scheduleDocumentFrame(scope, function () {
    if (!scope.term || gen !== scope.terminalGeneration) {
      return
    }
    const cellW = getCellWidth(scope)
    const cellH = getCellHeight(scope)
    // Fit the native frame with the shared formula; pre-ready engines stay hidden until init supplies it.
    const frame = scope.hostFrame
    if (!frame) {
      return
    }
    if (cellW > 0 && cellH > 0) {
      const fit = fitDimensionsFromCell(
        { cellWidth: cellW, cellHeight: cellH },
        frame.width,
        frame.height
      )
      if (!fit) {
        // Even below minimum grid width, update fit for the new cells; hidden hosts defer it.
        applyFitScale(scope, 'text-scale')
        return
      }
      scope.term.resize(fit.cols, fit.rows)
    }
    applyFitScale(scope, 'text-scale')
  })
}

export function startTextScaling(scope: TerminalDocumentScope) {
  scope.currentTextScale = scope.start().textScale
  scope.scrollIndicator = elementInRoot(scope.root, 'scroll-indicator')
  scope.scrollThumb = elementInRoot(scope.root, 'scroll-thumb')
  scope.terminalFontFamily = terminalFontFamilyForAmbiguousWidth('narrow')
}
