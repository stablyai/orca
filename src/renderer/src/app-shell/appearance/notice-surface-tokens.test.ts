import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  hexToRgb,
  mix,
  rgbaToHex,
  type Rgba
} from '../../../../shared/color/rgba-contrast'
import { noticeSurfaceTokens } from './notice-surface-tokens'
import { safePluginThemeTokens } from './plugin-theme-tokens'

const DARK_BUILT_INS = {
  '--foreground': '#f0f0f0',
  '--popover': '#171717',
  '--popover-foreground': '#f0f0f0',
  '--muted-foreground': '#acacac'
}
const probe = (value: string): Rgba | null => (value.startsWith('#') ? hexToRgb(value) : null)
const percent = (value: string): number => Number.parseFloat(value)
/** What the screen shows: color-mix results land on 8-bit channels. */
const painted = (color: Rgba): Rgba => hexToRgb(rgbaToHex(color))

/** What the cards paint: main.css's dark notice surface and secondary, with these tokens. */
function paintedNotice(themeTokens: Record<string, string>): {
  surface: Rgba
  secondary: Rgba
  text: Rgba
  muted: Rgba
  notice: Record<string, string>
} {
  const colors = { ...DARK_BUILT_INS, ...themeTokens }
  const notice = noticeSurfaceTokens(themeTokens, 'dark', DARK_BUILT_INS, probe)
  const foreground = hexToRgb(colors['--foreground'])
  const surface = mix(foreground, hexToRgb(colors['--popover']), percent(notice['--notice-lift']))
  return {
    surface: painted(surface),
    secondary: painted(mix(foreground, surface, percent(notice['--notice-secondary-mix']))),
    text: hexToRgb(colors['--popover-foreground']),
    muted: hexToRgb(notice['--notice-muted-foreground']),
    notice
  }
}

function expectReadable(themeTokens: Record<string, string>): void {
  const { surface, secondary, text, muted } = paintedNotice(themeTokens)
  expect(contrastRatio(surface, text)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(secondary, text)).toBeGreaterThanOrEqual(4.5)
  expect(contrastRatio(surface, muted)).toBeGreaterThanOrEqual(4.5)
}

describe('noticeSurfaceTokens', () => {
  it("keeps Orca's dark lift, secondary mix and muted text for the built-in palette", () => {
    expect(noticeSurfaceTokens({}, 'dark', DARK_BUILT_INS, probe)).toEqual({
      '--notice-lift': '7%',
      '--notice-secondary-mix': '10%',
      '--notice-secondary-edge': 'transparent',
      '--notice-muted-foreground': '#acacac'
    })
  })

  // Popover pairs the theme validator accepts; lifted as-is they dropped card text under 4.5:1.
  // #383838 passed only before rounding the muted color to the painted hex.
  it.each<Record<string, string>>([
    { '--popover': '#444444' },
    { '--popover': '#383838' },
    { '--popover': '#303030', '--popover-foreground': '#a0a0a0' },
    { '--popover': '#ffffff', '--popover-foreground': '#111111' }
  ])('keeps painted notice text 4.5:1 for an accepted %o', (themeTokens) => {
    expectReadable(themeTokens)
  })

  it('keeps painted notice text 4.5:1 for every gray popover the validator accepts', () => {
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
    const { notice } = paintedNotice({ '--popover': '#303030', '--popover-foreground': '#a0a0a0' })
    expect(notice['--notice-secondary-mix']).toBe('0%')
    expect(notice['--notice-secondary-edge']).toBe('var(--notice-border)')
  })
})
