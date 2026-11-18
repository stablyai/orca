import { MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'
import { paintedThemeColors, type ColorProbe } from './plugin-theme-tokens'
import {
  contrastRatio,
  hexToRgb,
  mix,
  rgbaToHex,
  type Rgba
} from '../../../../shared/color/rgba-contrast'

export const NOTICE_SURFACE_TOKEN = '--notice-surface'
export const NOTICE_SECONDARY_TOKEN = '--notice-secondary'
export const NOTICE_MUTED_FOREGROUND_TOKEN = '--notice-muted-foreground'
export const NOTICE_SECONDARY_EDGE_TOKEN = '--notice-secondary-edge'
export const NOTICE_MUTED_TOKEN = '--notice-muted'
export const NOTICE_ACCENT_TOKEN = '--notice-accent'
export const NOTICE_ACCENT_FOREGROUND_TOKEN = '--notice-accent-foreground'
export const NOTICE_INPUT_TOKEN = '--notice-input'
export const NOTICE_EDGE_TOKEN = '--notice-edge'
export const NOTICE_OUTLINE_EDGE_TOKEN = '--notice-outline-edge'
// Keep in sync with the built-in notice mixes in main.css.
const NOTICE_LIFT = { light: 0, dark: 7 } as const
const NOTICE_SECONDARY_MIX = { light: 6, dark: 10 } as const
// Keep in sync with the [data-description] color-mix in main.css.
const NOTICE_DESCRIPTION_OPACITY = 80

const BLACK: Rgba = [0, 0, 0, 1]
const painted = (color: Rgba): Rgba => hexToRgb(rgbaToHex(color))
const step = (color: Rgba, by: number): Rgba => [
  Math.min(255, Math.max(0, color[0] + by)),
  Math.min(255, Math.max(0, color[1] + by)),
  Math.min(255, Math.max(0, color[2] + by)),
  1
]

/** 4.5:1 even with each color one 8-bit step toward the other, so a theme color that paints a
 *  channel off (fractional CSS colors round their own way) can't sink below the floor. */
function readable(a: Rgba, b: Rgba): boolean {
  const [lighter, darker] = contrastRatio(a, BLACK) >= contrastRatio(b, BLACK) ? [a, b] : [b, a]
  return contrastRatio(step(lighter, -1), step(darker, 1)) >= MIN_TEXT_CONTRAST
}

/** `tint` mixed into `base` at the deepest percent, from `deepest` down, where `reads` holds. */
function deepestReadableMix(
  tint: Rgba,
  base: Rgba,
  deepest: number,
  reads: (candidate: Rgba) => boolean
): Rgba {
  for (let percent = deepest; percent > 0; percent--) {
    const candidate = painted(mix(tint, base, percent))
    if (reads(candidate)) {
      return candidate
    }
  }
  return painted(base)
}

/**
 * Toasts and corner cards lift the popover toward the foreground and paint popover and muted
 * text on it, but a theme's popover pair is only checked unlifted. So the lift and secondary
 * fill shrink until popover text stays readable (on the surface, its 80% description blend
 * too), and muted text moves toward popover text until it does too, on the surface and on muted
 * panels. Emitted as final hex colors: CSS paints exactly the colors measured here.
 */
export function noticeSurfaceTokensFor(
  colors: { foreground: Rgba; popover: Rgba; popoverForeground: Rgba; mutedForeground: Rgba },
  base: 'light' | 'dark'
): Record<string, string> {
  const { foreground, popover, popoverForeground, mutedForeground } = colors
  if ([foreground, popover, popoverForeground, mutedForeground].some((color) => color[3] < 1)) {
    return {}
  }
  const text = painted(popoverForeground)
  // Why: toast descriptions paint popover text at 80% (main.css [data-description]), so the lift
  // must keep that blend readable too, not just the opaque text.
  const surface = deepestReadableMix(
    foreground,
    popover,
    NOTICE_LIFT[base],
    (candidate) =>
      readable(candidate, text) &&
      readable(candidate, painted(mix(text, candidate, NOTICE_DESCRIPTION_OPACITY)))
  )
  const secondary = deepestReadableMix(
    foreground,
    surface,
    NOTICE_SECONDARY_MIX[base],
    (candidate) => readable(candidate, text)
  )
  // Muted panels (bg-muted/N) paint between the surface and the secondary fill, so muted text
  // must read on both ends.
  const mutedReads = (color: Rgba): boolean =>
    readable(surface, color) && readable(secondary, color)
  let muted = painted(mutedForeground)
  for (let towardText = 1; towardText <= 100 && !mutedReads(muted); towardText++) {
    muted = painted(mix(popoverForeground, mutedForeground, towardText))
  }
  const surfaceHex = rgbaToHex(surface)
  const secondaryHex = rgbaToHex(secondary)
  return {
    [NOTICE_SURFACE_TOKEN]: surfaceHex,
    [NOTICE_SECONDARY_TOKEN]: secondaryHex,
    // Why: with no fill left, secondary buttons need an edge to still read as buttons.
    [NOTICE_SECONDARY_EDGE_TOKEN]:
      secondaryHex === surfaceHex ? 'var(--notice-border)' : 'transparent',
    // Why: built-in palettes set --muted equal to --secondary; keeping that here keeps muted panels
    // on the notice surface's polarity when a theme's popover and app polarity differ.
    [NOTICE_MUTED_TOKEN]: secondaryHex,
    [NOTICE_MUTED_FOREGROUND_TOKEN]: rgbaToHex(muted),
    // Why: hover (bg-accent, bg-accent/50) and outline fills (dark:bg-input/30, /50) paint under
    // popover text in the notice scope; the secondary fill is the deepest one it stays readable on.
    [NOTICE_ACCENT_TOKEN]: secondaryHex,
    [NOTICE_ACCENT_FOREGROUND_TOKEN]: rgbaToHex(text),
    [NOTICE_INPUT_TOKEN]: secondaryHex,
    // Why: edges never sit under text, so they follow the popover text like the card border does;
    // the theme's own --border/--input can be on the app's polarity, not the popover's.
    [NOTICE_EDGE_TOKEN]: 'var(--notice-border)',
    // Why: --input now only fills, so dark outline buttons (border-input) need the edge drawn.
    [NOTICE_OUTLINE_EDGE_TOKEN]: 'var(--notice-border)'
  }
}

/** noticeSurfaceTokensFor a theme's tokens, which already passed safePluginThemeTokens. */
export function noticeSurfaceTokens(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): Record<string, string> {
  const effective = paintedThemeColors(tokens, base, builtIns, probe)
  const foreground = effective('--foreground')
  const popover = effective('--popover')
  const popoverForeground = effective('--popover-foreground')
  const mutedForeground = effective('--muted-foreground')
  return foreground && popover && popoverForeground && mutedForeground
    ? noticeSurfaceTokensFor({ foreground, popover, popoverForeground, mutedForeground }, base)
    : {}
}
