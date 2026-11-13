import { describe, expect, it } from 'vitest'
import { hexToRgb, type Rgba } from '../../../../shared/color/rgba-contrast'
import { noticeSurfaceTokens } from './notice-surface-tokens'

const DARK_BUILT_INS = {
  '--foreground': '#f0f0f0',
  '--popover': '#171717',
  '--popover-foreground': '#f0f0f0',
  '--muted': '#262626',
  '--muted-foreground': '#acacac'
}
const probe = (value: string): Rgba | null => (value.startsWith('#') ? hexToRgb(value) : null)

/** WCAG 2 contrast written out here, so the check shares no math with the code under test. */
function wcagContrast(firstHex: string, secondHex: string): number {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((start) => {
      const c = Number.parseInt(hex.slice(start, start + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [high, low] = [luminance(firstHex), luminance(secondHex)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

/** `over` with `top` painted at `alpha`, as the browser blends a bg-muted/N panel. */
function composite(topHex: string, overHex: string, alpha: number): string {
  return `#${[1, 3, 5]
    .map((start) => {
      const top = Number.parseInt(topHex.slice(start, start + 2), 16)
      const under = Number.parseInt(overHex.slice(start, start + 2), 16)
      return Math.round(top * alpha + under * (1 - alpha))
        .toString(16)
        .padStart(2, '0')
    })
    .join('')}`
}

/** The emitted tokens are the painted colors, so their contrast is what the user sees. */
function expectReadable(themeTokens: Record<string, string>): void {
  const palette: Record<string, string> = { ...DARK_BUILT_INS, ...themeTokens }
  const text = palette['--popover-foreground']
  const notice: Record<string, string> = noticeSurfaceTokens(
    themeTokens,
    'dark',
    DARK_BUILT_INS,
    probe
  )
  const surface = notice['--notice-surface']
  const muted = notice['--notice-muted-foreground']
  expect(wcagContrast(surface, text)).toBeGreaterThanOrEqual(4.5)
  // Toast descriptions paint popover text at 80%. Lifting must not push them under 4.5:1, nor
  // below the unlifted popover's own contrast when the theme already sat under it.
  const description = (under: string): number => wcagContrast(composite(text, under, 0.8), under)
  expect(description(surface)).toBeGreaterThanOrEqual(
    Math.min(4.5, description(palette['--popover']))
  )
  expect(wcagContrast(notice['--notice-secondary'], text)).toBeGreaterThanOrEqual(4.5)
  expect(wcagContrast(surface, muted)).toBeGreaterThanOrEqual(4.5)
  // UpdateErrorCardContent's bg-muted/30, /40 and /50 panels hold muted and body text. Without a
  // --notice-muted token, main.css paints them from the palette's --muted.
  const mutedPanel = notice['--notice-muted'] ?? palette['--muted']
  for (const alpha of [0.3, 0.4, 0.5]) {
    const panel = composite(mutedPanel, surface, alpha)
    expect(wcagContrast(panel, muted)).toBeGreaterThanOrEqual(4.5)
    expect(wcagContrast(panel, text)).toBeGreaterThanOrEqual(4.5)
  }
}

describe('noticeSurfaceTokens', () => {
  // Popovers the theme validator accepts that once painted notice text under 4.5:1: #5a5a5a
  // through Chromium's color-mix rounding and an over-lifted 80% description, #383838 through hex
  // rounding, white-on-dark-base through dark muted panels, the rest unlifted.
  it.each<Record<string, string>>([
    { '--popover': '#5a5a5a' },
    { '--popover': '#383838' },
    { '--popover': '#444444' },
    { '--popover': '#303030', '--popover-foreground': '#a0a0a0' },
    { '--popover': '#ffffff', '--popover-foreground': '#111111' }
  ])('keeps notice text 4.5:1 for an accepted %o', (themeTokens) => {
    expectReadable(themeTokens)
  })

  it('outlines secondary buttons only when their fill is gone', () => {
    const tokensFor = (popoverForeground: string): Record<string, string> =>
      noticeSurfaceTokens(
        { '--popover': '#303030', '--popover-foreground': popoverForeground },
        'dark',
        DARK_BUILT_INS,
        probe
      )
    const unfilled = tokensFor('#989898')
    expect(unfilled['--notice-secondary']).toBe(unfilled['--notice-surface'])
    expect(unfilled['--notice-secondary-edge']).toBe('var(--notice-border)')
    const filled = tokensFor('#a0a0a0')
    expect(filled['--notice-secondary']).not.toBe(filled['--notice-surface'])
    expect(filled['--notice-secondary-edge']).toBe('transparent')
  })
})
