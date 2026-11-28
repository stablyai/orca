import { getCellHeight, getCellWidth } from './cell-metrics'
import { elementInRoot } from '../document-host-seams'
import { terminalFontPxForScale } from '../../preferences/terminal-text-scales'
import type { TerminalDocumentScope } from '../document-scope'
import { scheduleDocumentFrame } from '../document-frame-registry'
import { applyFitScale } from './fit-scale'
import { fitDimensionsFromCell } from '../../viewport/terminal-grid-fit'
import {
  DEFAULT_TERMINAL_FONT_STYLE,
  readTerminalFontStyle,
  sameTerminalFontStyle,
  terminalBoldWeight,
  terminalFontFace,
  terminalFontFamilyCss,
  type TerminalFontStyle
} from '../../preferences/terminal-font-style'

// Re-init temporarily clears ready; latch prior readiness so width reflow cannot turn a transient error fatal.

// Pinch zoom is transient CSS; release commits a real font preset so the grid reflows and native resizes the PTY.

export function isIOSWebView() {
  if (/iP(ad|hone|od)/.test(navigator.userAgent)) {
    return true
  }
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
// Wait one frame after changing fontSize for cell metrics, then fit the new grid before native PTY reflow.
export function applyTextScale(scope: TerminalDocumentScope, scale: number) {
  scope.currentTextScale = scale
  if (!scope.term) {
    return
  }
  const px = terminalFontPxForScale(scale)
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
  const start = scope.start()
  scope.currentTextScale = start.textScale
  scope.scrollIndicator = elementInRoot(scope.root, 'scroll-indicator')
  scope.scrollThumb = elementInRoot(scope.root, 'scroll-thumb')
  scope.terminalFontFamily = terminalFontFamilyCss('system', isIOSWebView())
  applyTerminalFontStyle(scope, start.fontStyle ?? DEFAULT_TERMINAL_FONT_STYLE)
}

/** xterm options for the committed family and the chosen weight and line spacing. */
export function terminalFontOptions(scope: TerminalDocumentScope) {
  const style = scope.terminalFontStyle
  return {
    fontFamily: scope.terminalFontFamily,
    fontWeight: String(style.weight),
    fontWeightBold: String(terminalBoldWeight(style.weight)),
    lineHeight: style.lineHeight
  }
}

// A native WebView has no asset server, so its host sends the picked bundled face as CSS.
function installFontFaceCss(font: TerminalFontStyle['font'], css: unknown) {
  if (typeof css !== 'string' || css === '' || typeof document === 'undefined') {
    return
  }
  if (document.head.querySelector(`style[data-orca-terminal-font="${font}"]`)) {
    return
  }
  const style = document.createElement('style')
  style.setAttribute('data-orca-terminal-font', font)
  style.textContent = css
  document.head.appendChild(style)
}

// One glyph from each subset face (latin, latin-ext): WebGL keeps a glyph drawn while its face was still loading.
const FONT_FACE_PROBE_TEXT = 'W\u0141'

function fontFaceLoaded(face: string) {
  try {
    return !document.fonts || document.fonts.check(`16px "${face}"`, FONT_FACE_PROBE_TEXT)
  } catch {
    return true
  }
}

// Keep the grid: the new cell box reaches native as a refit, and native resizes the PTY.
function commitTerminalFont(scope: TerminalDocumentScope, family: string) {
  scope.terminalFontFamily = family
  const term = scope.term
  if (!term) {
    return
  }
  const next = terminalFontOptions(scope)
  const options = term.options
  if (
    options.fontFamily === next.fontFamily &&
    options.fontWeight === next.fontWeight &&
    options.fontWeightBold === next.fontWeightBold &&
    options.lineHeight === next.lineHeight
  ) {
    return
  }
  options.fontFamily = next.fontFamily
  options.fontWeight = next.fontWeight
  options.fontWeightBold = next.fontWeightBold
  options.lineHeight = next.lineHeight
  applyFitScale(scope, 'font-style')
}

// A bundled face joins the family only once loaded; xterm measures cells once per family and would keep the fallback's.
export function applyTerminalFontStyle(
  scope: TerminalDocumentScope,
  value: unknown,
  fontFaceCss?: unknown
) {
  const style: TerminalFontStyle = readTerminalFontStyle(value, scope.terminalFontStyle)
  if (sameTerminalFontStyle(style, scope.terminalFontStyle) && scope.term) {
    return
  }
  scope.terminalFontStyle = style
  scope.terminalFontLoad = null
  installFontFaceCss(style.font, fontFaceCss)
  const family = terminalFontFamilyCss(style.font, isIOSWebView())
  const face = terminalFontFace(style.font)
  if (!face || fontFaceLoaded(face)) {
    commitTerminalFont(scope, family)
    return
  }
  // Weight and spacing apply now; the family follows its face.
  commitTerminalFont(scope, scope.terminalFontFamily)
  const settle = () => {
    if (scope.terminalFontStyle === style) {
      scope.terminalFontLoad = null
      commitTerminalFont(scope, family)
    }
  }
  scope.terminalFontLoad = document.fonts
    .load(`16px "${face}"`, FONT_FACE_PROBE_TEXT)
    .then(settle, settle)
}
