import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { accentInkHex, accentInkContrast } from '../../../../shared/color/accent-ink'
import { contrastRatio, hexToRgb } from '../../../../shared/color/rgba-contrast'
import { safePluginThemeTokens, type ColorProbe } from './plugin-theme-tokens'

const MIN = 4.5
const AMBER = '#b45309'
const hexProbe: ColorProbe = (value) =>
  /^#[0-9a-f]{6}$/i.test(value.trim()) ? hexToRgb(value.trim()) : null
const ratio = (a: string, b: string): number => contrastRatio(hexToRgb(a), hexToRgb(b))

// The built-in accents and labels as main.css paints them: light block first, then dark.
const css = readFileSync(fileURLToPath(new URL('../../assets/main.css', import.meta.url)), 'utf8')
const builtIn = (name: string): string[] =>
  [...css.matchAll(new RegExp(`--${name}: (#[0-9a-f]{6});`, 'gi'))].map((match) => match[1])
const [lightAccent, darkAccent] = builtIn('callout-note')
const [lightLabel, darkLabel] = builtIn('theme-accent-foreground')

describe('theme accent label', () => {
  it('matches the built-in light and dark labels main.css paints', () => {
    expect(lightAccent).toBeDefined()
    expect(accentInkHex(hexToRgb(lightAccent))).toBe(lightLabel)
    expect(accentInkHex(hexToRgb(darkAccent))).toBe(darkLabel)
  })

  it.each([
    ['built-in light', lightAccent],
    ['built-in dark', darkAccent],
    ['amber #b45309', AMBER]
  ])('reads at 4.5:1 or better on the %s accent', (_name, accent) => {
    expect(accentInkContrast(hexToRgb(accent))).toBeGreaterThanOrEqual(MIN)
  })

  it('picks whichever of near-black or near-white reads better across a grey ramp', () => {
    for (let channel = 0; channel <= 255; channel += 5) {
      const hex = [channel, channel, channel].map((c) => c.toString(16).padStart(2, '0')).join('')
      const accent = hexToRgb(`#${hex}`)
      const label = hexToRgb(accentInkHex(accent))
      const other = accentInkHex(accent) === '#fafafa' ? '#171717' : '#fafafa'
      expect(contrastRatio(accent, label)).toBeGreaterThanOrEqual(
        contrastRatio(accent, hexToRgb(other))
      )
    }
  })
})

describe('safePluginThemeTokens: the accent label', () => {
  const base = { '--background': '#ffffff', '--foreground': '#0a0a0a' }
  const builtIns = { '--text-link': lightAccent, '--theme-accent-foreground': lightLabel }
  const run = (tokens: Record<string, string>, themeBase: 'light' | 'dark' = 'dark') =>
    safePluginThemeTokens({ ...base, ...tokens }, themeBase, builtIns, hexProbe)

  it('derives the label from an accent the theme sets, on either base', () => {
    for (const themeBase of ['light', 'dark'] as const) {
      const out = run({ '--text-link': AMBER }, themeBase)
      expect(out['--theme-accent-foreground']).toBe('#fafafa')
      expect(ratio(AMBER, out['--theme-accent-foreground'])).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('keeps the built-in look for a default-blue theme accent', () => {
    expect(run({ '--text-link': darkAccent }, 'dark')['--theme-accent-foreground']).toBe(darkLabel)
  })

  it('keeps an explicit label that reads on the accent', () => {
    const out = run({ '--text-link': AMBER, '--theme-accent-foreground': '#ffffff' })
    expect(out['--theme-accent-foreground']).toBe('#ffffff')
  })

  it('replaces an explicit label that does not read on the accent', () => {
    const out = run({ '--text-link': AMBER, '--theme-accent-foreground': '#171717' })
    expect(out['--theme-accent-foreground']).toBe('#fafafa')
  })

  it('drops an accent that neither near-black nor white reads on, keeping the built-in accent', () => {
    const grey = '#767676'
    expect(accentInkContrast(hexToRgb(grey))).toBeLessThan(MIN)
    const out = run({ '--text-link': grey })
    expect(out).not.toHaveProperty('--text-link')
    expect(out).not.toHaveProperty('--theme-accent-foreground')
  })

  it('adds no label when the theme sets no accent or label', () => {
    expect(run({})).not.toHaveProperty('--theme-accent-foreground')
  })
})
