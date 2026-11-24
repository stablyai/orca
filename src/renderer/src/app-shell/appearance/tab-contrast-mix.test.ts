import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  hexToRgb,
  mix,
  over,
  type Rgba
} from '../../../../shared/color/rgba-contrast'
import { safePluginThemeTokens, type ColorProbe } from './plugin-theme-tokens'
import { UNFOCUSED_SPLIT_GROUP_OPACITY } from '../../components/tab-group/panel/split-group-dim'
import { tabContrastTokens } from './tab-contrast-mix'

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

/** Rounded to 8 bits per channel, as Chrome paints a color-mix or a composite. */
const paintedRgb = (color: Rgba): Rgba => [
  Math.round(color[0]),
  Math.round(color[1]),
  Math.round(color[2]),
  1
]

const recess = (foreground: string, bar: string, percent: number) =>
  paintedRgb(mix(hexToRgb(foreground), hexToRgb(bar), percent))

/** A label on a tab fill in an unfocused split group, dimmed over the page. */
const unfocusedRatio = (fill: Rgba, label: Rgba, page: string) => {
  const dim = (color: Rgba) =>
    paintedRgb(mix(color, hexToRgb(page), UNFOCUSED_SPLIT_GROUP_OPACITY * 100))
  return contrastRatio(dim(fill), dim(label))
}

/** Safe tokens and the mix painted for them, as applyPluginAppTheme computes both. */
function paint(tokens: Record<string, string>, base: 'light' | 'dark') {
  const safe = safePluginThemeTokens(tokens, base, BUILT_INS[base], probe)
  const styles = tabContrastTokens(safe, base, BUILT_INS[base], probe)
  return { safe, styles, mix: Number.parseInt(styles['--tab-contrast-mix'], 10) }
}

describe('tabContrastMix', () => {
  it('paints the full depth for the built-in colors', () => {
    expect(paint({}, 'light').mix).toBe(8)
    expect(paint({}, 'dark').mix).toBe(11)
  })

  it('keeps the built-in light inactive label at 4.5:1 in an unfocused split group', () => {
    const { mix: percent, styles } = paint({}, 'light')
    const fill = recess('#0a0a0a', '#ffffff', percent)
    const muted = hexToRgb('#696969')
    // As is, the dimmed group takes the label under 4.5:1 at the full depth.
    expect(unfocusedRatio(fill, muted, '#ffffff')).toBeLessThan(4.5)
    expect(styles['--tab-unfocused-inactive-label']).toBe(
      'color-mix(in srgb, black 10%, var(--muted-foreground))'
    )
    const darkened = paintedRgb(mix(hexToRgb('#000000'), muted, 10))
    expect(unfocusedRatio(fill, darkened, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('preserves a readable fallback label on an explicit dark inactive fill in light mode', () => {
    const tokens = {
      '--background': '#000000',
      '--card': '#141414',
      '--foreground': '#fefefe',
      '--muted': '#000000',
      '--muted-foreground': '#757575',
      '--tab-inactive': '#000000'
    }
    const { safe, styles } = paint(tokens, 'light')
    expect(safe['--tab-inactive']).toBe('#000000')
    expect(safe['--muted-foreground']).toBe('#757575')
    expect(styles['--tab-unfocused-inactive-label']).toBe('var(--muted-foreground)')
    expect(contrastRatio(hexToRgb('#000000'), hexToRgb('#757575'))).toBeGreaterThanOrEqual(4.5)
  })

  it("stops short where a theme's own inactive label would drop under 4.5:1 in an unfocused split", () => {
    const tokens = { '--tab-inactive-foreground': '#696969' }
    const { safe, mix: percent } = paint(tokens, 'light')
    expect(safe).toEqual(tokens)
    expect(percent).toBeLessThan(8)
    const fill = recess('#0a0a0a', '#ffffff', percent)
    expect(unfocusedRatio(fill, hexToRgb('#696969'), '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('picks a depth whose painted fill keeps the label at 4.5:1', () => {
    const tokens = {
      '--background': '#ffffff',
      '--card': '#ffffff',
      '--foreground': '#232323',
      '--muted-foreground': '#6c6c6c'
    }
    // Unrounded, 8% reads 4.50:1; Chrome paints #ededed, which reads 4.49:1.
    const exact = mix(hexToRgb('#232323'), hexToRgb('#ffffff'), 8)
    expect(contrastRatio(exact, hexToRgb('#6c6c6c'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(recess('#232323', '#ffffff', 8), hexToRgb('#6c6c6c'))).toBeLessThan(4.5)
    const { mix: percent } = paint(tokens, 'light')
    expect(percent).toBeLessThan(8)
    const fill = recess('#232323', '#ffffff', percent)
    expect(contrastRatio(fill, hexToRgb('#6c6c6c'))).toBeGreaterThanOrEqual(4.5)
  })

  it("keeps the tabs apart where a light theme sets only the active tab's fill", () => {
    const tokens = { '--tab-active': '#ebebeb' }
    const { safe, mix: percent } = paint(tokens, 'light')
    expect(safe).toEqual(tokens)
    // The full depth would paint the inactive tabs #ebebeb too.
    expect(recess('#0a0a0a', '#ffffff', 8)).toEqual(hexToRgb('#ebebeb'))
    const separation = (at: number) =>
      contrastRatio(recess('#0a0a0a', '#ffffff', at), hexToRgb('#ebebeb'))
    expect(separation(percent)).toBeGreaterThanOrEqual(separation(4))
  })

  it('keeps a one-sided theme fill separated even after split compositing', () => {
    const tokens = {
      '--background': '#cdcdcd',
      '--card': '#fefefe',
      '--tab-active': '#efefef',
      '--muted-foreground': '#575757'
    }
    const { safe, mix: percent } = paint(tokens, 'light')
    expect(safe['--tab-active']).toBe('#efefef')
    const separation = (at: number) =>
      unfocusedRatio(recess('#0a0a0a', '#fefefe', at), hexToRgb('#efefef'), '#cdcdcd')
    expect(separation(percent)).toBeGreaterThanOrEqual(separation(4))
  })

  it("keeps the tabs apart where a dark theme sets only the inactive tab's fill", () => {
    const tokens = { '--tab-inactive': '#2f2f2f' }
    const { safe, mix: percent } = paint(tokens, 'dark')
    expect(safe).toEqual(tokens)
    expect(recess('#f0f0f0', '#171717', 11)).toEqual(hexToRgb('#2f2f2f'))
    const separation = (at: number) =>
      contrastRatio(recess('#f0f0f0', '#171717', at), hexToRgb('#2f2f2f'))
    expect(separation(percent)).toBeGreaterThanOrEqual(separation(6))
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
      '--foreground': '#282828',
      '--muted-foreground': '#6e6e6e'
    }
    // The full depth would take the label from passing to 4.40:1.
    expect(contrastRatio(recess('#282828', '#ffffff', 8), hexToRgb('#6e6e6e'))).toBeLessThan(4.5)
    const { mix: percent } = paint(tokens, 'light')
    expect(percent).toBeLessThan(8)
    expect(percent).toBeGreaterThan(4)
    const inactive = recess('#282828', '#ffffff', percent)
    expect(contrastRatio(inactive, hexToRgb('#6e6e6e'))).toBeGreaterThanOrEqual(4.5)
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
})
