import { TERMINAL_BUNDLED_FONTS } from '../fonts/terminal-font-face-css.mjs'

// Storage-free so the terminal document can validate what the app sends it.

export type TerminalBundledFontId = keyof typeof TERMINAL_BUNDLED_FONTS
/** `system` is SF Mono on iOS and the system mono stack on Android. */
export type TerminalFontId = 'system' | 'menlo' | 'courier-new' | TerminalBundledFontId

export const TERMINAL_FONT_IDS: readonly TerminalFontId[] = [
  'system',
  'menlo',
  'courier-new',
  'jetbrains-mono',
  'fira-code',
  'geist-mono'
]

export const TERMINAL_LINE_HEIGHTS = [1, 1.15, 1.3] as const
/** Regular text weights; bold is always two steps heavier. */
export const TERMINAL_FONT_WEIGHTS = [300, 400, 500] as const

export type TerminalFontStyle = {
  font: TerminalFontId
  lineHeight: number
  weight: number
}

/** Today's phone look: SF Mono Light, no extra leading. */
export const DEFAULT_TERMINAL_FONT_STYLE: TerminalFontStyle = {
  font: 'system',
  lineHeight: 1,
  weight: 300
}

/** Tablets start roomier, since phone sizes look small on a large screen. */
export const TABLET_TERMINAL_FONT_STYLE: TerminalFontStyle = {
  font: 'system',
  lineHeight: 1.15,
  weight: 400
}

export function isTerminalBundledFont(font: string): font is TerminalBundledFontId {
  // Not Object.hasOwn: the native document still targets Chrome 74 WebViews.
  return Object.keys(TERMINAL_BUNDLED_FONTS).includes(font)
}

export function terminalBoldWeight(weight: number): number {
  return weight + 200
}

function pick<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback
}

/** Keeps each known field and falls back per field, since a newer app may store ids this build lacks. */
export function readTerminalFontStyle(
  value: unknown,
  fallback: TerminalFontStyle
): TerminalFontStyle {
  const fields: { font?: unknown; lineHeight?: unknown; weight?: unknown } =
    typeof value === 'object' && value !== null ? value : {}
  return {
    font: pick(TERMINAL_FONT_IDS, fields.font, fallback.font),
    lineHeight: pick<number>(TERMINAL_LINE_HEIGHTS, fields.lineHeight, fallback.lineHeight),
    weight: pick<number>(TERMINAL_FONT_WEIGHTS, fields.weight, fallback.weight)
  }
}

export function sameTerminalFontStyle(a: TerminalFontStyle, b: TerminalFontStyle): boolean {
  return a.font === b.font && a.lineHeight === b.lineHeight && a.weight === b.weight
}

// iOS WebKit may resolve "SF Mono" to a proportional face, so it leads with ui-monospace.
const MONO_FALLBACKS =
  '"Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", monospace'

function systemMonoStack(ios: boolean): string {
  // iOS already draws ⏴⏵⏶⏷ from system fonts; Android has none.
  return ios
    ? `ui-monospace, ${MONO_FALLBACKS}`
    : `"SF Mono", ${MONO_FALLBACKS}, "Orca Terminal Symbols"`
}

/** The CSS face a bundled font must load before it can be measured, or null for system fonts. */
export function terminalFontFace(font: TerminalFontId): string | null {
  return isTerminalBundledFont(font) ? TERMINAL_BUNDLED_FONTS[font].family : null
}

/** CSS font-family for a font id; every stack ends in the system mono stack for missing glyphs. */
export function terminalFontFamilyCss(font: TerminalFontId, ios: boolean): string {
  const lead =
    font === 'menlo'
      ? '"Menlo", '
      : font === 'courier-new'
        ? '"Courier New", '
        : isTerminalBundledFont(font)
          ? `"${TERMINAL_BUNDLED_FONTS[font].family}", `
          : ''
  return lead + systemMonoStack(ios)
}
