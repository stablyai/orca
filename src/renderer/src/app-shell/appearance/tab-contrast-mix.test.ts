import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, mix, over } from '../../../../shared/color/rgba-contrast'
import { applyPluginAppTheme } from './document-theme'
import { safePluginThemeTokens, type ColorProbe } from './plugin-theme-tokens'
import { TAB_CONTRAST_MIX_TOKEN, tabContrastMix } from './tab-contrast-mix'

const probe: ColorProbe = (value) => (/^#[0-9a-f]{3,6}$/i.test(value) ? hexToRgb(value) : null)

// main.css's built-in values for the tokens the tab checks read.
const BUILT_INS = {
  light: {
    '--background': '#ffffff',
    '--foreground': '#0a0a0a',
    '--card': '#ffffff',
    '--muted': '#f5f5f5',
    '--muted-foreground': '#696969',
    '--sidebar': '#fafafa'
  },
  dark: {
    '--background': '#0a0a0a',
    '--foreground': '#f0f0f0',
    '--card': '#171717',
    '--muted': '#262626',
    '--muted-foreground': '#acacac',
    '--sidebar': '#171717'
  }
} as const

const recess = (foreground: string, bar: string, percent: number) =>
  mix(hexToRgb(foreground), hexToRgb(bar), percent)

/** Safe tokens and the mix painted for them, as applyPluginAppTheme computes both. */
function paint(tokens: Record<string, string>, base: 'light' | 'dark') {
  const safe = safePluginThemeTokens(tokens, base, BUILT_INS[base], probe)
  return { safe, mix: tabContrastMix(safe, base, BUILT_INS[base], probe) }
}

describe('tabContrastMix', () => {
  it('paints the full depth for the built-in colors', () => {
    expect(paint({}, 'light').mix).toBe(8)
    expect(paint({}, 'dark').mix).toBe(11)
  })

  it('paints the full depth on a tinted light tab bar that sets no tab colors', () => {
    const latte = {
      '--background': '#eff1f5',
      '--foreground': '#4c4f69',
      '--card': '#e6e9ef',
      '--muted-foreground': '#5c5f77'
    }
    const { mix: percent } = paint(latte, 'light')
    expect(percent).toBe(8)
    const inactive = recess('#4c4f69', '#e6e9ef', percent)
    expect(contrastRatio(inactive, hexToRgb('#5c5f77'))).toBeGreaterThanOrEqual(4.5)
  })

  it('stops short of the depth that would take passing inactive tab text under 4.5:1', () => {
    const tokens = {
      '--background': '#ffffff',
      '--muted': '#ffffff',
      '--foreground': '#6e6e6e',
      '--muted-foreground': '#717171'
    }
    // The full depth would take the label from passing to 4.45:1.
    expect(contrastRatio(recess('#6e6e6e', '#ffffff', 8), hexToRgb('#717171'))).toBeLessThan(4.5)
    const { mix: percent } = paint(tokens, 'light')
    expect(percent).toBeLessThan(8)
    expect(percent).toBeGreaterThan(4)
    const inactive = recess('#6e6e6e', '#ffffff', percent)
    expect(contrastRatio(inactive, hexToRgb('#717171'))).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the old depth where inactive tab text was already under 4.5:1', () => {
    const tokyoNightDay = {
      '--background': '#e1e2e7',
      '--foreground': '#3760bf',
      '--card': '#d0d5e3',
      '--muted-foreground': '#495994'
    }
    expect(contrastRatio(recess('#3760bf', '#d0d5e3', 4), hexToRgb('#495994'))).toBeLessThan(4.5)
    expect(paint(tokyoNightDay, 'light').mix).toBe(4)
  })

  it("keeps a light theme's own inactive tab fill that passed before", () => {
    const tokens = {
      '--background': '#ffffff',
      '--foreground': '#666666',
      '--muted-foreground': '#000000',
      '--tab-inactive': '#777777',
      '--tab-active-foreground': '#000000'
    }
    expect(paint(tokens, 'light').safe).toEqual(tokens)
  })

  it("keeps a dark theme's own tab line and lifts the active tab only as far as it reads", () => {
    const tokens = { '--tab-active-indicator': '#595959' }
    const { safe, mix: percent } = paint(tokens, 'dark')
    expect(safe).toEqual(tokens)
    expect(percent).toBeLessThan(11)
    expect(percent).toBeGreaterThanOrEqual(6)
    const active = recess('#f0f0f0', '#171717', percent)
    expect(contrastRatio(active, over(hexToRgb('#595959'), active))).toBeGreaterThanOrEqual(2)
  })

  it('keeps every tab color of a theme that sets them all', () => {
    const light = {
      '--tab-bar': '#dce0e8',
      '--tab-active': '#eff1f5',
      '--tab-active-foreground': '#8637ed',
      '--tab-active-indicator': '#8839ef',
      '--tab-inactive': '#e6e9ef',
      '--tab-inactive-foreground': '#646877'
    }
    const dark = {
      '--tab-bar': '#26282d',
      '--tab-active': '#24385b',
      '--tab-active-foreground': '#d1d3da',
      '--tab-active-indicator': '#759cf0',
      '--tab-inactive': '#26282d',
      '--tab-inactive-foreground': '#a6abb5'
    }
    expect(paint(light, 'light').safe).toEqual(light)
    expect(paint(dark, 'dark').safe).toEqual(dark)
  })

  it('paints the mix with the theme', () => {
    const painted = new Map<string, string>()
    const root = {
      style: {
        setProperty: (token: string, value: string) => void painted.set(token, value),
        removeProperty: (token: string) => (painted.delete(token), '')
      }
    }
    applyPluginAppTheme(
      { id: 'test', revision: '1', base: 'dark', tokens: { '--tab-active-indicator': '#595959' } },
      { root, probe, builtIns: () => BUILT_INS.dark, storage: null }
    )
    const percent = Number.parseInt(painted.get(TAB_CONTRAST_MIX_TOKEN) ?? '', 10)
    expect(percent).toBeGreaterThanOrEqual(6)
    expect(percent).toBeLessThan(11)
    applyPluginAppTheme(null, { root, storage: null })
    expect(painted.has(TAB_CONTRAST_MIX_TOKEN)).toBe(false)
  })
})
