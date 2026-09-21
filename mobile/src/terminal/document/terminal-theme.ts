import { terminalBackgroundFallback } from './document-constants'
import { scope, type TerminalDocumentTheme } from './document-scope'

/** A terminal colour with no alpha: what the contrast maths works on. */
export type TerminalDocumentRgb = { r: number; g: number; b: number }

/** A parsed CSS colour, alpha included, before it is composited onto the app surface. */
export type TerminalDocumentRgba = TerminalDocumentRgb & { a: number }

/** The theme payload the host publishes; an older host omits the contrast floor. */
export type TerminalDocumentThemeMessage =
  | { theme?: Record<string, string>; minimumContrastRatio?: number }
  | null
  | undefined

const DARK_BG_MIN_CONTRAST = 3
const LIGHT_BG_MIN_CONTRAST = 4.5
// Dark app surface a transparent terminal background composites over (matches desktop APP_SURFACE_COLORS.dark).
const CONTRAST_APP_SURFACE = { r: 10, g: 10, b: 10 }

export function parseTerminalBackgroundRgba(value: unknown): TerminalDocumentRgba | null {
  if (typeof value !== 'string') {
    return null
  }
  const v = value.trim().toLowerCase()
  if (!v) {
    return null
  }
  if (v === 'black') {
    return { r: 0, g: 0, b: 0, a: 1 }
  }
  if (v === 'white') {
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  if (v === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 }
  }
  const hex = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (hex) {
    const h = hex[1]
    let ch: number[]
    if (h.length === 3 || h.length === 4) {
      ch = h.split('').map(function (p) {
        return Number.parseInt(p + p, 16)
      })
    } else {
      ch = []
      for (let i = 0; i < h.length; i += 2) {
        ch.push(Number.parseInt(h.slice(i, i + 2), 16))
      }
    }
    return { r: ch[0], g: ch[1], b: ch[2], a: ch[3] === undefined ? 1 : ch[3] / 255 }
  }
  const rgb = v.match(/^rgba?\(([^)]+)\)$/)
  if (!rgb) {
    return null
  }
  // oxlint-disable-next-line unicorn/prefer-includes -- the document's text is pinned token for token; rewriting this changes the native program
  let parts = rgb[1].indexOf(',') >= 0 ? rgb[1].split(',') : rgb[1].split(/[\s/]+/)
  parts = parts
    .map(function (p) {
      return p.trim()
    })
    .filter(function (p) {
      return p.length > 0
    })
  if (parts.length < 3) {
    return null
  }
  const channel = function (p: string) {
    const n =
      p.charAt(p.length - 1) === '%' ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p)
    return Number.isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : null
  }
  const r = channel(parts[0]),
    g = channel(parts[1]),
    b = channel(parts[2])
  if (r === null || g === null || b === null) {
    return null
  }
  let a = 1
  if (parts[3] !== undefined) {
    const raw =
      parts[3].charAt(parts[3].length - 1) === '%'
        ? Number.parseFloat(parts[3]) / 100
        : Number.parseFloat(parts[3])
    a = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1
  }
  return { r: r, g: g, b: b, a: a }
}

export function terminalRelativeLuminance(rgb: TerminalDocumentRgb) {
  const lin = function (c: number) {
    const n = c / 255
    // oxlint-disable-next-line prefer-exponentiation-operator -- the document's text is pinned token for token; rewriting this changes the native program
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

export function terminalContrastRatio(a: TerminalDocumentRgb, b: TerminalDocumentRgb) {
  const la = terminalRelativeLuminance(a),
    lb = terminalRelativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// Clamp an explicit desktop override to xterm's 1-21 range; null means "no usable override".
export function normalizeTerminalContrastOverride(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.min(21, Math.max(1, value))
}

// Pick the xterm minimumContrastRatio floor from the composed terminal background.
// Unparseable input defaults to the dark floor so agent output never stays invisible.
export function resolveTerminalContrastFloor(background: unknown) {
  const color = parseTerminalBackgroundRgba(background)
  if (!color) {
    return DARK_BG_MIN_CONTRAST
  }
  const composited =
    color.a < 1
      ? {
          r: Math.round(color.r * color.a + CONTRAST_APP_SURFACE.r * (1 - color.a)),
          g: Math.round(color.g * color.a + CONTRAST_APP_SURFACE.g * (1 - color.a)),
          b: Math.round(color.b * color.a + CONTRAST_APP_SURFACE.b * (1 - color.a))
        }
      : color
  const isLight =
    terminalContrastRatio({ r: 0, g: 0, b: 0 }, composited) >=
    terminalContrastRatio({ r: 255, g: 255, b: 255 }, composited)
  return isLight ? LIGHT_BG_MIN_CONTRAST : DARK_BG_MIN_CONTRAST
}

export function normalizeTerminalTheme(input: TerminalDocumentThemeMessage) {
  const source =
    input && typeof input === 'object' && input.theme && typeof input.theme === 'object'
      ? input.theme
      : null
  if (!source) {
    return scope.defaultTheme
  }
  const next: Record<string, string> = {}
  const keys = Object.keys(scope.defaultTheme)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (typeof source[key] === 'string') {
      next[key] = source[key]
    }
  }
  return Object.assign({}, scope.defaultTheme, next)
}

/**
 * What `applyTerminalTheme` writes through. Both slots are written, so a target may arrive without
 * a theme; nothing else on the terminal is touched.
 */
export type TerminalDocumentThemeTarget = {
  options: { theme?: TerminalDocumentTheme; minimumContrastRatio: number }
}

export function applyTerminalTheme(input: TerminalDocumentThemeMessage) {
  scope.terminalThemeInput = input
  scope.terminalTheme = normalizeTerminalTheme(input)
  const background = scope.terminalTheme.background || terminalBackgroundFallback
  scope.paintDocumentBackground(background)
  // Why prefer the published value: the desktop user may have lowered or disabled the floor (#10754);
  // an older host omits the field and the luminance gate stays authoritative.
  const publishedFloor = normalizeTerminalContrastOverride(
    input && typeof input === 'object' ? input.minimumContrastRatio : undefined
  )
  scope.terminalMinimumContrastRatio =
    publishedFloor === null ? resolveTerminalContrastFloor(background) : publishedFloor
  if (scope.term) {
    scope.term.options.theme = scope.terminalTheme
    scope.term.options.minimumContrastRatio = scope.terminalMinimumContrastRatio
  }
}
