import { describe, expect, it } from 'vitest'
import { colors, darkColors, lightColors, type ThemeColors } from './mobile-theme'

const HEX = /^#[0-9a-f]{6}$/
const RGBA = /^rgba\(\d+, ?\d+, ?\d+, ?[0-9.]+\)$/
const SHARED_ACROSS_MODES = [
  'onAccent',
  'mergeGreen',
  'onMergeGreen'
] as const satisfies readonly (keyof ThemeColors)[]

type Rgb = readonly [number, number, number]
type Rgba = readonly [number, number, number, number]

function parseColor(value: string): Rgba {
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      1
    ]
  }
  const match = value.match(/^rgba?\((\d+), ?(\d+), ?(\d+)(?:, ?([0-9.]+))?\)$/)
  if (!match) {
    throw new Error(`unparseable color: ${value}`)
  }
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? 1 : Number(match[4])
  ]
}

function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2])
}

function compositeOver(fg: Rgba, bg: Rgb): Rgb {
  const a = fg[3]
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)]
}

function contrastRatio(fg: string, bg: string): number {
  const fgRgba = parseColor(fg)
  const bgRgb = parseColor(bg) as unknown as Rgb
  const fgRgb = fgRgba[3] < 1 ? compositeOver(fgRgba, bgRgb) : (fgRgba as unknown as Rgb)
  const L1 = luminance(fgRgb)
  const L2 = luminance(bgRgb)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}

// Floors: 4.5 body text, 3.0 UI glyph/dot/chip-fill. Dark (and a few light) pairs
// that already ship sub-target pin their measured ratio so this is a regression
// ratchet, not a rewrite of the existing dark palette.
const CONTRAST_PAIRS: ReadonlyArray<{
  fg: keyof ThemeColors
  bg: keyof ThemeColors
  dark: number
  light: number
}> = [
  { fg: 'textPrimary', bg: 'bgBase', dark: 4.5, light: 4.5 },
  { fg: 'textPrimary', bg: 'bgPanel', dark: 4.5, light: 4.5 },
  { fg: 'textPrimary', bg: 'bgRaised', dark: 4.5, light: 4.5 },
  { fg: 'textSecondary', bg: 'bgBase', dark: 4.5, light: 4.5 },
  { fg: 'textSecondary', bg: 'bgPanel', dark: 4.5, light: 4.34 },
  { fg: 'textSecondary', bg: 'bgRaised', dark: 4.37, light: 3.93 },
  { fg: 'textMuted', bg: 'bgBase', dark: 2.52, light: 3.0 },
  { fg: 'textMuted', bg: 'bgPanel', dark: 2.32, light: 3.0 },
  { fg: 'textMuted', bg: 'bgRaised', dark: 2.07, light: 3.0 },
  { fg: 'accentBlue', bg: 'bgBase', dark: 4.5, light: 4.5 },
  { fg: 'accentBlue', bg: 'bgPanel', dark: 4.5, light: 4.5 },
  // Why dark floor 4.21: measured 4.221 — already sub-4.5 on bgRaised.
  { fg: 'accentBlue', bg: 'bgRaised', dark: 4.21, light: 4.5 },
  { fg: 'onAccent', bg: 'accentBlue', dark: 3.67, light: 4.5 },
  { fg: 'bgBase', bg: 'surfaceBright', dark: 3.0, light: 3.0 },
  { fg: 'bgBase', bg: 'surfaceBrightPressed', dark: 3.0, light: 3.0 },
  { fg: 'statusGreen', bg: 'bgBase', dark: 3.0, light: 3.0 },
  { fg: 'statusAmber', bg: 'bgBase', dark: 3.0, light: 3.0 },
  { fg: 'statusRed', bg: 'bgBase', dark: 3.0, light: 3.0 },
  { fg: 'statusGreen', bg: 'bgRaised', dark: 3.0, light: 3.0 },
  { fg: 'statusAmber', bg: 'bgRaised', dark: 3.0, light: 3.0 },
  { fg: 'statusRed', bg: 'bgRaised', dark: 3.0, light: 3.0 },
  { fg: 'onMergeGreen', bg: 'mergeGreen', dark: 3.0, light: 3.0 },
  { fg: 'gitDecorationAdded', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'gitDecorationDeleted', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxComment', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxKeyword', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxString', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxNumber', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxType', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxFunction', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxVariable', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'syntaxMeta', bg: 'editorSurface', dark: 3.0, light: 3.0 },
  { fg: 'textPrimary', bg: 'terminalBg', dark: 4.5, light: 4.5 },
  { fg: 'textSecondary', bg: 'terminalBg', dark: 4.5, light: 4.5 }
]

describe('mobile theme palettes', () => {
  it('keeps dark and light key sets identical (31 keys)', () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort())
    expect(Object.keys(darkColors)).toHaveLength(31)
  })

  it('uses only 6-digit hex or rgba values, and textMuted is hex in both palettes', () => {
    for (const [name, palette] of [
      ['dark', darkColors],
      ['light', lightColors]
    ] as const) {
      for (const [key, value] of Object.entries(palette)) {
        expect(HEX.test(value) || RGBA.test(value), `${name}.${key}=${value}`).toBe(true)
      }
      expect(HEX.test(palette.textMuted), `${name}.textMuted must be 6-digit hex`).toBe(true)
    }
  })

  it('aliases colors to darkColors so unconverted modules keep rendering dark', () => {
    expect(colors).toBe(darkColors)
  })

  it('shares only the fixed on-fill tokens across modes; every other key differs', () => {
    for (const key of SHARED_ACROSS_MODES) {
      expect(lightColors[key]).toBe(darkColors[key])
    }
    const diverging = (Object.keys(darkColors) as Array<keyof ThemeColors>).filter(
      (key) => !SHARED_ACROSS_MODES.includes(key as (typeof SHARED_ACROSS_MODES)[number])
    )
    for (const key of diverging) {
      expect(lightColors[key], key).not.toBe(darkColors[key])
    }
    // Why explicit: terminalBg is the RN/CSS chrome around the WebView and must invert.
    expect(lightColors.terminalBg).not.toBe(darkColors.terminalBg)
  })

  it('holds the contrast ratchet for both palettes', () => {
    for (const pair of CONTRAST_PAIRS) {
      const darkRatio = contrastRatio(darkColors[pair.fg], darkColors[pair.bg])
      const lightRatio = contrastRatio(lightColors[pair.fg], lightColors[pair.bg])
      expect(darkRatio, `dark ${pair.fg}/${pair.bg}`).toBeGreaterThanOrEqual(pair.dark)
      expect(lightRatio, `light ${pair.fg}/${pair.bg}`).toBeGreaterThanOrEqual(pair.light)
    }
  })

  it('keeps diff washes in the [1.09, 1.25] strength band on editorSurface', () => {
    for (const [name, palette] of [
      ['dark', darkColors],
      ['light', lightColors]
    ] as const) {
      for (const washKey of ['diffAddedBg', 'diffDeletedBg'] as const) {
        const surface = parseColor(palette.editorSurface) as unknown as Rgb
        const wash = parseColor(palette[washKey])
        const composite = compositeOver(wash, surface)
        const L1 = luminance(composite)
        const L2 = luminance(surface)
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
        expect(ratio, `${name}.${washKey}`).toBeGreaterThanOrEqual(1.09)
        expect(ratio, `${name}.${washKey}`).toBeLessThanOrEqual(1.25)
      }
    }
  })
})
