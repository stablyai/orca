import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

/** Parses #rgb or #rrggbb into 0-255 channels. */
function hexToRgb(hex: string): number[] {
  const digits = hex.length === 4 ? hex.slice(1).replace(/./g, '$&$&') : hex.slice(1)
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16))
}

/** WCAG 2.x relative luminance of a hex color. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hex colors, independent of argument order. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Reads a token's hex value from one theme block; throws so a non-hex value fails loudly. */
function tokenIn(block: string, token: string): string {
  const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{3,6});`))
  if (!match) {
    throw new Error(`${token} is not a hex color in this theme block`)
  }
  return match[1]
}

const darkStart = mainCss.indexOf('\n.dark {')
const themes = {
  light: mainCss.slice(0, darkStart),
  dark: mainCss.slice(darkStart, mainCss.indexOf('\n}', darkStart))
}

describe('destructive token pair', () => {
  it.each(Object.entries(themes))('meets WCAG AA (4.5:1) in the %s theme', (_theme, block) => {
    const ratio = contrastRatio(
      tokenIn(block, '--destructive-foreground'),
      tokenIn(block, '--destructive')
    )
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
})
