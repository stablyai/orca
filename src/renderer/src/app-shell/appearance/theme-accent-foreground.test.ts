import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { accentInkHex, accentInkContrast } from '../../../../shared/color/accent-ink'
import { contrastRatio, hexToRgb } from '../../../../shared/color/rgba-contrast'
import { safePluginThemeTokens, type ColorProbe } from './plugin-theme-tokens'
import { themeAccentButtonTokens } from './theme-accent-button-tokens'

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

// What the theme-accent button paints for a theme: its fill and label after the validator and
// themeAccentButtonTokens, falling back to main.css's built-ins, as document-theme applies them.
function paintButton(
  tokens: Record<string, string>,
  themeBase: 'light' | 'dark',
  builtIns: Record<string, string>
): { safe: Record<string, string>; fill: string; label: string } {
  const safe = safePluginThemeTokens(tokens, themeBase, builtIns, hexProbe)
  const button = themeAccentButtonTokens(safe, builtIns, hexProbe)
  return {
    safe,
    fill: button['--theme-accent-fill'] ?? safe['--text-link'] ?? builtIns['--text-link'],
    label:
      button['--theme-accent-foreground'] ??
      safe['--theme-accent-foreground'] ??
      builtIns['--theme-accent-foreground']
  }
}

describe('themeAccentButtonTokens: the accent button', () => {
  const base = { '--background': '#ffffff', '--foreground': '#0a0a0a' }
  const builtIns = { '--text-link': lightAccent, '--theme-accent-foreground': lightLabel }
  const run = (tokens: Record<string, string>, themeBase: 'light' | 'dark' = 'dark') =>
    paintButton({ ...base, ...tokens }, themeBase, builtIns)

  it('fills with the theme accent and white ink for amber #b45309, on either base', () => {
    for (const themeBase of ['light', 'dark'] as const) {
      const { fill, label } = run({ '--text-link': AMBER }, themeBase)
      expect(fill).toBe(AMBER)
      expect(label).toBe('#fafafa')
      expect(ratio(fill, label)).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('keeps the built-in look for a default-blue theme accent', () => {
    expect(run({ '--text-link': darkAccent }, 'dark').label).toBe(darkLabel)
  })

  it('keeps an explicit label that reads on the accent', () => {
    const { fill, label } = run({ '--text-link': AMBER, '--theme-accent-foreground': '#ffffff' })
    expect([fill, label]).toEqual([AMBER, '#ffffff'])
  })

  it('rejects an explicit label that does not read on the accent', () => {
    const { safe, label } = run({ '--text-link': AMBER, '--theme-accent-foreground': '#171717' })
    expect(safe).not.toHaveProperty('--theme-accent-foreground')
    expect(label).toBe('#fafafa')
  })

  it.each(['#d73a49', '#cb4b16', '#dc322f'])(
    'keeps mid-tone %s as the link color; only the button falls back to the built-in accent',
    (midTone) => {
      expect(accentInkContrast(hexToRgb(midTone))).toBeLessThan(MIN)
      const { safe, fill, label } = run({ '--text-link': midTone })
      expect(safe['--text-link']).toBe(midTone)
      expect([fill, label]).toEqual([lightAccent, lightLabel])
      expect(ratio(fill, label)).toBeGreaterThanOrEqual(MIN)
    }
  )

  it('falls back on a mid-tone accent when the explicit label does not read on it', () => {
    const { safe, fill, label } = run({
      '--text-link': '#d73a49',
      '--theme-accent-foreground': '#fafafa'
    })
    expect(safe['--text-link']).toBe('#d73a49')
    expect([fill, label]).toEqual([lightAccent, lightLabel])
  })

  it('keeps a mid-tone accent when the theme sets a label that reads on it', () => {
    const { fill, label } = run({
      '--text-link': '#d73a49',
      '--theme-accent-foreground': '#000000'
    })
    expect([fill, label]).toEqual(['#d73a49', '#000000'])
    expect(ratio(fill, label)).toBeGreaterThanOrEqual(MIN)
  })

  it('paints nothing over the built-ins when the theme sets no accent', () => {
    expect(
      themeAccentButtonTokens(
        safePluginThemeTokens(base, 'dark', builtIns, hexProbe),
        builtIns,
        hexProbe
      )
    ).toEqual({})
  })
})

// Every theme Orca ships: the accent button's fill and label must read at 4.5:1.
const launchDir = fileURLToPath(
  new URL('../../../../../resources/plugins/launch/', import.meta.url)
)
const bundledThemes = readdirSync(launchDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(launchDir, entry.name, 'themes')))
  .flatMap((entry) =>
    readdirSync(join(launchDir, entry.name, 'themes'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => join(launchDir, entry.name, 'themes', file))
  )

describe('bundled themes: accent label contrast', () => {
  it('finds the bundled themes', () => {
    expect(bundledThemes.length).toBeGreaterThan(0)
  })

  it.each(bundledThemes.map((path) => [basename(path), path]))('%s', (_name, path) => {
    const theme: { base: 'light' | 'dark'; tokens: Record<string, string> } = JSON.parse(
      readFileSync(path, 'utf8')
    )
    const { fill, label } = paintButton(theme.tokens, theme.base, {
      '--text-link': theme.base === 'light' ? lightAccent : darkAccent,
      '--theme-accent-foreground': theme.base === 'light' ? lightLabel : darkLabel
    })
    expect(ratio(fill, label)).toBeGreaterThanOrEqual(MIN)
  })
})
