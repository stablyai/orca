import { MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'
import { paintedThemeColors, type ColorProbe } from './plugin-theme-tokens'
import {
  contrastRatio,
  hexToRgb,
  mix,
  rgbaToHex,
  type Rgba
} from '../../../../shared/color/rgba-contrast'

// Keep in sync with the notice tokens in main.css.
export const NOTICE_LIFT_TOKEN = '--notice-lift'
export const NOTICE_SECONDARY_MIX_TOKEN = '--notice-secondary-mix'
export const NOTICE_MUTED_FOREGROUND_TOKEN = '--notice-muted-foreground'
export const NOTICE_SECONDARY_EDGE_TOKEN = '--notice-secondary-edge'
export const NOTICE_LIFT = { light: 0, dark: 7 } as const
export const NOTICE_SECONDARY_MIX = { light: 6, dark: 10 } as const

/** The 8-bit color that is actually painted, so a pass can't round below the floor. */
const painted = (color: Rgba): Rgba => hexToRgb(rgbaToHex(color))

const readable = (surface: Rgba, text: Rgba): boolean =>
  contrastRatio(painted(surface), painted(text)) >= MIN_TEXT_CONTRAST

/** The deepest mix of `tint` into `surface`, from `deepest` down to 0, that keeps `text` readable. */
function deepestReadableMix(tint: Rgba, surface: Rgba, text: Rgba, deepest: number): number {
  for (let percent = deepest; percent > 0; percent--) {
    if (readable(mix(tint, surface, percent), text)) {
      return percent
    }
  }
  return 0
}

/**
 * Toasts and corner cards lift the popover toward the foreground and paint popover and muted
 * text on it. A theme's popover pair is only checked unlifted, so lift and secondary mix shrink
 * until popover text stays 4.5:1, and muted text moves toward popover text until it does too.
 */
export function noticeSurfaceTokensFor(
  colors: { foreground: Rgba; popover: Rgba; popoverForeground: Rgba; mutedForeground: Rgba },
  base: 'light' | 'dark'
): Record<string, string> {
  const { foreground, popover, popoverForeground, mutedForeground } = colors
  if ([foreground, popover, popoverForeground, mutedForeground].some((color) => color[3] < 1)) {
    return {}
  }
  const lift = deepestReadableMix(foreground, popover, popoverForeground, NOTICE_LIFT[base])
  const surface = mix(foreground, popover, lift)
  const secondaryMix = deepestReadableMix(
    foreground,
    surface,
    popoverForeground,
    NOTICE_SECONDARY_MIX[base]
  )
  let towardText = 0
  while (
    towardText < 100 &&
    !readable(surface, mix(popoverForeground, mutedForeground, towardText))
  ) {
    towardText++
  }
  return {
    [NOTICE_LIFT_TOKEN]: `${lift}%`,
    [NOTICE_SECONDARY_MIX_TOKEN]: `${secondaryMix}%`,
    // Why: with no fill left, secondary buttons need an edge to still read as buttons.
    [NOTICE_SECONDARY_EDGE_TOKEN]: secondaryMix === 0 ? 'var(--notice-border)' : 'transparent',
    [NOTICE_MUTED_FOREGROUND_TOKEN]: rgbaToHex(mix(popoverForeground, mutedForeground, towardText))
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
