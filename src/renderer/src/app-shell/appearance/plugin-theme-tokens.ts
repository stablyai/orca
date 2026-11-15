import { contrastRatio, mix, over, type Rgba } from '../../../../shared/color/rgba-contrast'
import { MIN_RING_CONTRAST } from '../../../../shared/theme/theme-contrast-rules'
import { paintedThemeColors, type ColorProbe } from '../../../../shared/theme/theme-contrast-engine'

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
