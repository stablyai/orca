import { pluginAppThemeCssFallback } from '../../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import { MIN_RING_CONTRAST, MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'
import { paintedThemeColors, type ColorProbe } from './plugin-theme-tokens'
import { contrastRatio, mix, over, type Rgba } from '../../../../shared/color/rgba-contrast'

export const TAB_CONTRAST_MIX_TOKEN = '--tab-contrast-mix'
// Keep in sync with --tab-contrast-mix in main.css.
export const TAB_CONTRAST_MIX = { light: 8, dark: 11 } as const

/** The tab the mix paints: light recesses the inactive tabs, dark lifts the active one. */
const MIXED_TAB = { light: '--tab-inactive', dark: '--tab-active' } as const

/** The mix the theme contrast check derives that tab at; a theme's own colors passed there. */
function checkedMix(base: 'light' | 'dark'): number {
  const rule = pluginAppThemeCssFallback(MIXED_TAB[base], base)
  return rule && 'mixForeground' in rule ? rule.mixForeground : TAB_CONTRAST_MIX[base]
}

export type TabInk = { color: Rgba; min: number }

/**
 * How much foreground the mixed tab takes over the tab bar: Orca's own depth, lowered (down to
 * the checked mix) until no ink on that tab reads worse than it did at the checked mix, or below
 * its minimum where it met it there.
 */
export function tabContrastMixOver(
  foreground: Rgba,
  bar: Rgba,
  inks: readonly TabInk[],
  base: 'light' | 'dark'
): number {
  const floor = checkedMix(base)
  // Why the checked mix: a translucent bar blends with what is under it, which this can't see.
  if (foreground[3] < 1 || bar[3] < 1) {
    return floor
  }
  const ratio = (ink: TabInk, percent: number): number => {
    const surface = mix(foreground, bar, percent)
    return contrastRatio(surface, over(ink.color, surface))
  }
  const needed = inks.map((ink) => Math.min(ink.min, ratio(ink, floor)))
  for (let percent = TAB_CONTRAST_MIX[base]; percent > floor; percent--) {
    if (inks.every((ink, index) => ratio(ink, percent) >= needed[index])) {
      return percent
    }
  }
  return floor
}

/** tabContrastMixOver for a theme's tokens, which already passed safePluginThemeTokens. */
export function tabContrastMix(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): number {
  const effective = paintedThemeColors(tokens, base, builtIns, probe)
  const foreground = effective('--foreground')
  const bar = effective('--tab-bar')
  if (!foreground || !bar) {
    return checkedMix(base)
  }
  const text = (token: string): TabInk[] => {
    const color = effective(token)
    return color ? [{ color, min: MIN_TEXT_CONTRAST }] : []
  }
  // Light: inactive labels, and the active text they take on hover. Dark: the active label and
  // its line (the light active tab is the bar itself, so its line doesn't move).
  const indicator = effective('--tab-active-indicator')
  const inks =
    base === 'light'
      ? [...text('--tab-inactive-foreground'), ...text('--tab-active-foreground')]
      : [
          ...text('--tab-active-foreground'),
          ...(indicator ? [{ color: indicator, min: MIN_RING_CONTRAST }] : [])
        ]
  return tabContrastMixOver(foreground, bar, inks, base)
}
