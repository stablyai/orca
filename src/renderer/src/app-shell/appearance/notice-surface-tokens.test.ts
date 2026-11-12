import { describe, expect, it } from 'vitest'
import { hexToRgb, rgbaToHex, type Rgba } from '../../../../shared/color/rgba-contrast'
import { noticeSurfaceTokens } from './notice-surface-tokens'
import { safePluginThemeTokens } from './plugin-theme-tokens'

const DARK_BUILT_INS = {
  '--foreground': '#f0f0f0',
  '--popover': '#171717',
  '--popover-foreground': '#f0f0f0',
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

/** The emitted tokens are the painted colors, so their contrast is what the user sees. */
function expectReadable(themeTokens: Record<string, string>): void {
  const text = { ...DARK_BUILT_INS, ...themeTokens }['--popover-foreground']
  const notice = noticeSurfaceTokens(themeTokens, 'dark', DARK_BUILT_INS, probe)
  expect(wcagContrast(notice['--notice-surface'], text)).toBeGreaterThanOrEqual(4.5)
  expect(wcagContrast(notice['--notice-secondary'], text)).toBeGreaterThanOrEqual(4.5)
  expect(
    wcagContrast(notice['--notice-surface'], notice['--notice-muted-foreground'])
  ).toBeGreaterThanOrEqual(4.5)
}

describe('noticeSurfaceTokens', () => {
  it("paints Orca's dark notice colors for the built-in palette", () => {
    expect(noticeSurfaceTokens({}, 'dark', DARK_BUILT_INS, probe)).toEqual({
      '--notice-surface': '#262626',
      '--notice-secondary': '#3a3a3a',
      '--notice-secondary-edge': 'transparent',
      '--notice-muted-foreground': '#acacac'
    })
  })

  // Popovers the theme validator accepts that once painted notice text under 4.5:1: #5a5a5a
  // through Chromium's color-mix rounding, #383838 through hex rounding, the rest unlifted.
  it.each<Record<string, string>>([
    { '--popover': '#5a5a5a' },
    { '--popover': '#383838' },
    { '--popover': '#444444' },
    { '--popover': '#303030', '--popover-foreground': '#a0a0a0' },
    { '--popover': '#ffffff', '--popover-foreground': '#111111' }
  ])('keeps notice text 4.5:1 for an accepted %o', (themeTokens) => {
    expectReadable(themeTokens)
  })

  it('keeps notice text 4.5:1 for every gray popover the validator accepts', () => {
    const accepted = Array.from({ length: 256 }, (_, gray) => ({
      '--popover': rgbaToHex([gray, gray, gray, 1])
    })).filter(
      (tokens) => safePluginThemeTokens(tokens, 'dark', DARK_BUILT_INS, probe)['--popover']
    )
    expect(accepted.length).toBeGreaterThan(50)
    for (const tokens of accepted) {
      expectReadable(tokens)
    }
  })

  it('outlines secondary buttons only when their fill is gone', () => {
    const notice = noticeSurfaceTokens(
      { '--popover': '#303030', '--popover-foreground': '#a0a0a0' },
      'dark',
      DARK_BUILT_INS,
      probe
    )
    expect(notice['--notice-secondary']).toBe(notice['--notice-surface'])
    expect(notice['--notice-secondary-edge']).toBe('var(--notice-border)')
  })
})
