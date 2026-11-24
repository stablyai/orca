import { pluginAppThemeCssFallback } from '../../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import { UNFOCUSED_SPLIT_GROUP_OPACITY } from '../../components/tab-group/panel/split-group-dim'
import { MIN_RING_CONTRAST, MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'
import { paintedThemeColors, type ColorProbe } from './plugin-theme-tokens'
import { contrastRatio, mix, over, type Rgba } from '../../../../shared/color/rgba-contrast'

export const TAB_CONTRAST_MIX_TOKEN = '--tab-contrast-mix'
// Keep in sync with --tab-contrast-mix in main.css.
export const TAB_CONTRAST_MIX = { light: 8, dark: 11 } as const
// Keep in sync with --tab-inactive-label in main.css: how much black a light unfocused split
// group mixes into the fallback inactive tab label, against the group's dimming.
export const UNFOCUSED_TAB_LABEL_DARKEN = 10
const BLACK: Rgba = [0, 0, 0, 1]

/** The tab the mix paints: light recesses the inactive tabs, dark lifts the active one. */
const MIXED_TAB = { light: '--tab-inactive', dark: '--tab-active' } as const
/** The other tab's fill, which the mixed tab has to stay apart from. */
const OTHER_TAB = { light: '--tab-active', dark: '--tab-inactive' } as const

/** The mix the theme contrast check derives that tab at; a theme's own colors passed there. */
function checkedMix(base: 'light' | 'dark'): number {
  const rule = pluginAppThemeCssFallback(MIXED_TAB[base], base)
  return rule && 'mixForeground' in rule ? rule.mixForeground : TAB_CONTRAST_MIX[base]
}

/** Chrome paints a color-mix or a composite at 8 bits per channel. */
function painted([r, g, b]: Rgba): Rgba {
  return [Math.round(r), Math.round(g), Math.round(b), 1]
}

/** How a color shows in an unfocused split group, which paints at reduced opacity over the page. */
function dimmed(color: Rgba, page: Rgba): Rgba {
  return painted(mix(color, page, UNFOCUSED_SPLIT_GROUP_OPACITY * 100))
}

export type TabInk = {
  color: Rgba
  min: number
  /** The ink in an unfocused split group; omitted where that group hides it (the tab line). */
  unfocused?: Rgba
}

export type TabStrip = {
  foreground: Rgba
  bar: Rgba
  /** What an unfocused split group shows through. */
  page: Rgba
  /** The other tab's fill (the bar itself unless the theme sets one). */
  otherTab: Rgba
  inks: readonly TabInk[]
}

/**
 * How much foreground the mixed tab takes over the tab bar: Orca's own depth, lowered (down to
 * the checked mix) until, as painted, focused or in an unfocused split group, no ink on that
 * tab reads worse than it did at the checked mix, or below its minimum where it met it there,
 * and the tab is no closer to the other tab's fill than it was there.
 */
export function tabContrastMixOver(strip: TabStrip, base: 'light' | 'dark'): number {
  const { foreground, bar, page, otherTab, inks } = strip
  const floor = checkedMix(base)
  // Why the checked mix: a translucent color blends with what is under it, which this can't see.
  if ([foreground, bar, page].some((color) => color[3] < 1)) {
    return floor
  }
  const surface = (percent: number): Rgba => painted(mix(foreground, bar, percent))
  const measures: { at: (percent: number) => number; min: number }[] = [
    // Why no minimum: keep the tabs at least as far apart as the checked mix had them; a theme's
    // own other-tab fill can sit right where a deeper mix lands.
    {
      at: (percent) => contrastRatio(surface(percent), painted(over(otherTab, bar))),
      min: Infinity
    }
  ]
  for (const ink of inks) {
    measures.push({
      at: (percent) => contrastRatio(surface(percent), painted(over(ink.color, surface(percent)))),
      min: ink.min
    })
    const { unfocused } = ink
    if (unfocused) {
      measures.push({
        at: (percent) => {
          const fill = surface(percent)
          return contrastRatio(dimmed(fill, page), dimmed(painted(over(unfocused, fill)), page))
        },
        min: ink.min
      })
    }
  }
  const needed = measures.map((measure) => Math.min(measure.min, measure.at(floor)))
  for (let percent = TAB_CONTRAST_MIX[base]; percent > floor; percent--) {
    if (measures.every((measure, index) => measure.at(percent) >= needed[index])) {
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
  const page = effective('--background')
  const otherTab = effective(OTHER_TAB[base])
  if (!foreground || !bar || !page || !otherTab) {
    return checkedMix(base)
  }
  const text = (token: string, unfocused?: Rgba | null): TabInk[] => {
    const color = effective(token)
    return color ? [{ color, min: MIN_TEXT_CONTRAST, unfocused: unfocused ?? color }] : []
  }
  // Why only the fallback label: a theme's own --tab-inactive-foreground is painted as set.
  const inactive = effective('--tab-inactive-foreground')
  const unfocusedInactive =
    base === 'light' && inactive && !tokens['--tab-inactive-foreground']
      ? painted(mix(BLACK, inactive, UNFOCUSED_TAB_LABEL_DARKEN))
      : inactive
  // Light: inactive labels, and the active text they take on hover. Dark: the active label and
  // its line (the light active tab is the bar itself, so its line doesn't move).
  const indicator = effective('--tab-active-indicator')
  const inks =
    base === 'light'
      ? [
          ...text('--tab-inactive-foreground', unfocusedInactive),
          ...text('--tab-active-foreground')
        ]
      : [
          ...text('--tab-active-foreground'),
          ...(indicator ? [{ color: indicator, min: MIN_RING_CONTRAST }] : [])
        ]
  return tabContrastMixOver({ foreground, bar, page, otherTab, inks }, base)
}
