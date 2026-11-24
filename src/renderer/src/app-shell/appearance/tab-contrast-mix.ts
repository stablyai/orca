import { pluginAppThemeCssFallback } from '../../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import { UNFOCUSED_SPLIT_GROUP_OPACITY } from '../../components/tab-group/panel/split-group-dim'
import { STATUS_COLORS } from '../../lib/source-control/paths/git-path-decoration'
import { MIN_RING_CONTRAST, MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'
import { paintedThemeColors, type ColorProbe } from './plugin-theme-tokens'
import { contrastRatio, mix, over, type Rgba } from '../../../../shared/color/rgba-contrast'

export const TAB_CONTRAST_MIX_TOKEN = '--tab-contrast-mix'
// Keep in sync with --tab-contrast-mix in main.css.
export const TAB_CONTRAST_MIX = { light: 8, dark: 11 } as const
// Keep in sync with --tab-inactive-label in main.css: how much black a light unfocused split
// group mixes into the fallback inactive tab label, against the group's dimming.
const UNFOCUSED_TAB_LABEL_DARKEN = 10
const BLACK: Rgba = [0, 0, 0, 1]
const WHITE: Rgba = [255, 255, 255, 1]
const UNFOCUSED_TAB_LABEL_TOKEN = '--tab-unfocused-inactive-label'

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

type TabInk = {
  color: Rgba
  min: number
  /** The ink in an unfocused split group; omitted where that group hides it (the tab line). */
  unfocused?: boolean
}

type TabStrip = {
  foreground: Rgba
  bar: Rgba
  /** What an unfocused split group shows through. */
  page: Rgba
  /** The other tab's fill (the bar itself unless the theme sets one). */
  otherTab: Rgba
  inks: readonly TabInk[]
  inactiveFallback: Rgba | null
}

function inkContrast(ink: Rgba, fill: Rgba, page?: Rgba): number {
  const label = painted(over(ink, fill))
  return page ? contrastRatio(dimmed(fill, page), dimmed(label, page)) : contrastRatio(fill, label)
}

function unfocusedLabel(ink: Rgba, fill: Rgba, page: Rgba): Rgba {
  const contrast = inkContrast(ink, fill, page)
  if (ink[3] < 1 || contrast >= MIN_TEXT_CONTRAST) {
    return ink
  }
  const darker = painted(mix(BLACK, ink, UNFOCUSED_TAB_LABEL_DARKEN))
  return inkContrast(darker, fill, page) > contrast &&
    inkContrast(darker, fill) >= inkContrast(ink, fill)
    ? darker
    : ink
}

function mixedFill(foreground: Rgba, bar: Rgba, percent: number): Rgba {
  return painted(mix(foreground, bar, percent))
}

function tabContrastMixOver(strip: TabStrip, base: 'light' | 'dark'): number {
  const { foreground, bar, page, otherTab, inks, inactiveFallback } = strip
  const floor = checkedMix(base)
  const oldFill = mixedFill(foreground, bar, floor)
  const otherFill = painted(over(otherTab, bar))
  const dimmedOtherFill = dimmed(otherFill, page)
  const separation = contrastRatio(oldFill, otherFill)
  const dimmedSeparation = contrastRatio(dimmed(oldFill, page), dimmedOtherFill)
  const minimums = inks.map(({ color, min, unfocused }) => ({
    focused: Math.min(min, inkContrast(color, oldFill)),
    unfocused: unfocused ? Math.min(min, inkContrast(color, oldFill, page)) : 0
  }))
  for (let percent = TAB_CONTRAST_MIX[base]; percent > floor; percent--) {
    const fill = mixedFill(foreground, bar, percent)
    if (
      contrastRatio(fill, otherFill) >= separation &&
      contrastRatio(dimmed(fill, page), dimmedOtherFill) >= dimmedSeparation &&
      inks.every(({ color, unfocused }, index) => {
        const minimum = minimums[index]
        const dimmedInk = color === inactiveFallback ? unfocusedLabel(color, fill, page) : color
        return (
          inkContrast(color, fill) >= minimum.focused &&
          (!unfocused || inkContrast(dimmedInk, fill, page) >= minimum.unfocused)
        )
      })
    ) {
      return percent
    }
  }
  return floor
}

function decorationMix(ink: Rgba, fill: Rgba, page: Rgba): string | undefined {
  if (
    inkContrast(ink, fill) >= MIN_TEXT_CONTRAST &&
    inkContrast(ink, fill, page) >= MIN_TEXT_CONTRAST
  ) {
    return undefined
  }
  const toward = inkContrast(BLACK, fill, page) >= inkContrast(WHITE, fill, page) ? BLACK : WHITE
  for (let percent = 5; percent <= 100; percent += 5) {
    const color = painted(mix(toward, ink, percent))
    if (
      inkContrast(color, fill) >= MIN_TEXT_CONTRAST &&
      inkContrast(color, fill, page) >= MIN_TEXT_CONTRAST
    ) {
      return `${toward === BLACK ? 'black' : 'white'} ${percent}%`
    }
  }
  return undefined
}

/** Colors derived from the accepted theme tokens, without changing which tokens are accepted. */
export function tabContrastTokens(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): Record<string, string> {
  const effective = paintedThemeColors(tokens, base, builtIns, probe)
  const foreground = effective('--foreground')
  const bar = effective('--tab-bar')
  const page = effective('--background')
  const otherTab = effective(OTHER_TAB[base])
  const text = (token: string): TabInk[] => {
    const color = effective(token)
    return color ? [{ color, min: MIN_TEXT_CONTRAST, unfocused: true }] : []
  }
  const inactive = text('--tab-inactive-foreground')
  const inactiveFallback =
    base === 'light' && !tokens['--tab-inactive-foreground'] ? (inactive[0]?.color ?? null) : null
  const indicator = effective('--tab-active-indicator')
  const inks =
    base === 'light'
      ? [...inactive, ...text('--tab-active-foreground')]
      : [
          ...text('--tab-active-foreground'),
          ...(indicator ? [{ color: indicator, min: MIN_RING_CONTRAST }] : [])
        ]
  const strip =
    foreground?.[3] === 1 && bar?.[3] === 1 && page?.[3] === 1 && otherTab
      ? { foreground, bar, page, otherTab, inks, inactiveFallback }
      : null
  const explicitFill = tokens[MIXED_TAB[base]] ? effective(MIXED_TAB[base]) : null
  const percent = strip && !explicitFill ? tabContrastMixOver(strip, base) : checkedMix(base)
  const fill =
    strip &&
    (explicitFill
      ? painted(over(explicitFill, strip.bar))
      : mixedFill(strip.foreground, strip.bar, percent))
  const darken =
    base === 'light' &&
    strip &&
    fill &&
    inactiveFallback &&
    unfocusedLabel(inactiveFallback, fill, strip.page) !== inactiveFallback
  const overrides: Record<string, string> = {
    [TAB_CONTRAST_MIX_TOKEN]: `${percent}%`,
    [UNFOCUSED_TAB_LABEL_TOKEN]: darken
      ? `color-mix(in srgb, black ${UNFOCUSED_TAB_LABEL_DARKEN}%, var(--muted-foreground))`
      : 'var(--muted-foreground)'
  }
  for (const [status, source] of Object.entries(STATUS_COLORS)) {
    const ink = effective(`--git-decoration-${status}`)
    const blend =
      strip && fill && ink?.[3] === 1 && percent > checkedMix(base)
        ? decorationMix(ink, fill, strip.page)
        : undefined
    overrides[`--tab-decoration-${status}`] = blend
      ? `color-mix(in srgb, ${blend}, ${source})`
      : source
  }
  return overrides
}
