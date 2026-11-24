import {
  pluginAppThemeCssFallback,
  type PluginThemeCssFallbackRule
} from '../../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import {
  BORDERS,
  CONTRAST_RULES,
  MIN_BORDER_ALPHA,
  MIN_RING_CONTRAST,
  RINGS,
  type ContrastRule
} from './plugin-theme-contrast-rules'

import { contrastRatio, mix, over, type Rgba } from '../../../../shared/color/rgba-contrast'

/** sRGB channels 0-255 and alpha 0-1, or null when the value is not a CSS color. */
export type ColorProbe = (value: string) => Rgba | null

/** The `over` layers painted bottom-up; opaque only when the bottom layer is. */
function paintedLayers(
  layers: ContrastRule['over'],
  effective: (token: string) => Rgba | null
): Rgba | null {
  const stack = typeof layers === 'string' ? [layers] : (layers ?? [])
  return stack.reduceRight<Rgba | null>((below, layer) => {
    const color = effective(layer)
    return color && below?.[3] === 1 ? over(color, below) : color
  }, null)
}

/** A token as main.css paints it: the theme's own color, else its CSS fallback, else built-in. */
function themeTokenResolver(
  own: (token: string) => Rgba | null | undefined,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): (token: string) => Rgba | null {
  const builtInColors = new Map<string, Rgba | null>()
  const derived = (rule: PluginThemeCssFallbackRule): Rgba | null => {
    if ('tint' in rule) {
      const hue = effective(rule.tint)
      if (!hue) {
        return null
      }
      if (!rule.into) {
        return [hue[0], hue[1], hue[2], (hue[3] * rule.percent) / 100]
      }
      const into = effective(rule.into)
      return into ? mix(hue, into, rule.percent) : null
    }
    if (!('mixForeground' in rule)) {
      return rule.map(effective).find(Boolean) ?? null
    }
    const foreground = effective('--foreground')
    const into = effective(rule.into ?? '--background')
    return foreground && into ? mix(foreground, into, rule.mixForeground) : null
  }
  function effective(token: string): Rgba | null {
    const color = own(token)
    if (color) {
      return color
    }
    const fallback = pluginAppThemeCssFallback(token, base)
    if (fallback) {
      return derived(fallback)
    }
    if (!builtInColors.has(token)) {
      builtInColors.set(token, builtIns[token] ? probe(builtIns[token]) : null)
    }
    return builtInColors.get(token) ?? null
  }
  return effective
}

/**
 * The plugin tokens that are safe to paint over the built-in ones for the theme's base.
 * Checks run on the effective set (plugin values, else what main.css derives from them, else
 * built-in), and dropping a token can expose a value that breaks another pair, so checks repeat
 * until nothing changes. Dropped tokens keep their built-in values.
 */
export function safePluginThemeTokens(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): Record<string, string> {
  const accepted = new Map<string, Rgba>()
  for (const [token, value] of Object.entries(tokens)) {
    const color = probe(value)
    if (color && !(BORDERS.includes(token) && color[3] < MIN_BORDER_ALPHA)) {
      accepted.set(token, color)
    }
  }
  const effective = themeTokenResolver((token) => accepted.get(token), base, builtIns, probe)
  const drop = (...pair: string[]): boolean =>
    pair.map((token) => accepted.delete(token)).some(Boolean)

  for (let changed = true; changed;) {
    changed = false
    for (const rule of CONTRAST_RULES) {
      const dropped =
        rule.surfaceSource && tokens[rule.surface] === undefined
          ? [...rule.dropped, rule.surfaceSource]
          : rule.dropped
      // Why skip: a check with nothing of the theme's to drop can't change the result, so a
      // theme that sets none of a check's tokens pays no probes for it.
      if (!dropped.some((token) => accepted.has(token))) {
        continue
      }
      const textColor = effective(rule.text)
      const ownSurface = effective(rule.surface)
      const beneath = paintedLayers(rule.over, effective)
      const surfaceColor = ownSurface && beneath?.[3] === 1 ? over(ownSurface, beneath) : ownSurface
      const min =
        rule.noWorseThanOver && beneath?.[3] === 1 && textColor?.[3] === 1
          ? Math.min(rule.min, contrastRatio(beneath, textColor))
          : rule.min
      if (
        surfaceColor &&
        textColor &&
        (surfaceColor[3] < 1 || textColor[3] < 1 || contrastRatio(surfaceColor, textColor) < min)
      ) {
        changed = drop(...dropped) || changed
      }
    }
    for (const [ring, surface] of RINGS) {
      const ringColor = accepted.get(ring)
      if (!ringColor) {
        continue
      }
      const surfaceColor = effective(surface)
      if (
        surfaceColor &&
        contrastRatio(over(ringColor, surfaceColor), surfaceColor) < MIN_RING_CONTRAST
      ) {
        changed = drop(ring) || changed
      }
    }
  }
  return Object.fromEntries(Object.entries(tokens).filter(([token]) => accepted.has(token)))
}

export const HOST_PILL_OUTLINE_MIX_TOKEN = '--worktree-host-pill-outline-mix'
// Keep in sync with the host pill outline's fallback in main.css.
const HOST_PILL_OUTLINE_MIX = 40

/**
 * How much sidebar text the selected card's host pill outline mixes into the sidebar: Orca's 40%,
 * raised to the smallest mix that stands out from the selected wash painted over the sidebar.
 */
export function hostPillOutlineMixOver(foreground: Rgba, sidebar: Rgba, wash: Rgba | null): number {
  if (foreground[3] < 1 || sidebar[3] < 1) {
    return HOST_PILL_OUTLINE_MIX
  }
  const card = wash ? over(wash, sidebar) : sidebar
  // Why the ring floor: the wash matches the pill's fill, so the outline alone keeps the pill from
  // vanishing. Orca's own outline (2.3:1 light, 2.5:1 dark) already clears 2:1 and stays at 40%;
  // a dimmer theme gets only the smallest mix that reaches it.
  for (let percent = HOST_PILL_OUTLINE_MIX; percent < 100; percent++) {
    if (contrastRatio(mix(foreground, sidebar, percent), card) >= MIN_RING_CONTRAST) {
      return percent
    }
  }
  return 100
}

/** Each token as main.css paints it for a theme whose tokens already passed safePluginThemeTokens. */
export function paintedThemeColors(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): (token: string) => Rgba | null {
  return themeTokenResolver(
    (token) => (tokens[token] ? probe(tokens[token]) : null),
    base,
    builtIns,
    probe
  )
}

/** hostPillOutlineMixOver for a theme's tokens, which already passed safePluginThemeTokens. */
export function hostPillOutlineMix(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): number {
  const effective = paintedThemeColors(tokens, base, builtIns, probe)
  const foreground = effective('--worktree-sidebar-foreground')
  const sidebar = effective('--worktree-sidebar')
  return foreground && sidebar
    ? hostPillOutlineMixOver(foreground, sidebar, effective('--worktree-sidebar-active'))
    : HOST_PILL_OUTLINE_MIX
}

let probeContext: OffscreenCanvasRenderingContext2D | null | undefined

/** Resolves a color through the browser's own parser by painting one pixel. */
export const browserColorProbe: ColorProbe = (value) => {
  if (typeof CSS === 'undefined' || !CSS.supports('color', value)) {
    return null
  }
  probeContext ??=
    typeof OffscreenCanvas === 'undefined'
      ? null
      : new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
  if (!probeContext) {
    return null
  }
  const context = probeContext
  // Why two seeds: fillStyle silently keeps its old value for values it rejects (e.g. `inherit`).
  const paint = (seed: string): number[] => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = seed
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  }
  const first = paint('#000000')
  const second = paint('#ffffff')
  if (first.some((channel, index) => channel !== second[index])) {
    return null
  }
  const [r = 0, g = 0, b = 0, a = 0] = first
  return [r, g, b, a / 255]
}
