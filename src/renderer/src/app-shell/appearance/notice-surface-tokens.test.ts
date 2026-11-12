import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, mix, type Rgba } from '../../../../shared/color/rgba-contrast'
import { noticeSurfaceTokens } from './notice-surface-tokens'

const DARK_BUILT_INS = {
  '--foreground': '#f0f0f0',
  '--popover': '#171717',
  '--popover-foreground': '#f0f0f0',
  '--muted-foreground': '#acacac'
}
const probe = (value: string): Rgba | null => (value.startsWith('#') ? hexToRgb(value) : null)
const percent = (value: string): number => Number.parseFloat(value)

/** What the cards paint: main.css's dark notice surface and secondary, with these tokens. */
function paintedNotice(themeTokens: Record<string, string>): {
  surface: Rgba
  secondary: Rgba
  text: Rgba
  muted: Rgba
} {
  const colors = { ...DARK_BUILT_INS, ...themeTokens }
  const notice = noticeSurfaceTokens(themeTokens, 'dark', DARK_BUILT_INS, probe)
  const foreground = hexToRgb(colors['--foreground'])
  const surface = mix(foreground, hexToRgb(colors['--popover']), percent(notice['--notice-lift']))
  return {
    surface,
    secondary: mix(foreground, surface, percent(notice['--notice-secondary-mix'])),
    text: hexToRgb(colors['--popover-foreground']),
    muted: hexToRgb(notice['--notice-muted-foreground'])
  }
}

describe('noticeSurfaceTokens', () => {
  it("keeps Orca's dark lift, secondary mix and muted text for the built-in palette", () => {
    expect(noticeSurfaceTokens({}, 'dark', DARK_BUILT_INS, probe)).toEqual({
      '--notice-lift': '7%',
      '--notice-secondary-mix': '10%',
      '--notice-muted-foreground': '#acacac'
    })
  })

  // Popover pairs the theme validator accepts; lifted as-is they dropped card text under 4.5:1.
  it.each([
    { '--popover': '#444444' },
    { '--popover': '#303030', '--popover-foreground': '#a0a0a0' },
    { '--popover': '#ffffff', '--popover-foreground': '#111111' }
  ])('keeps notice text 4.5:1 for an accepted %o', (themeTokens) => {
    const { surface, secondary, text, muted } = paintedNotice(themeTokens)
    expect(contrastRatio(surface, text)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(secondary, text)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(surface, muted)).toBeGreaterThanOrEqual(4.5)
  })
})
