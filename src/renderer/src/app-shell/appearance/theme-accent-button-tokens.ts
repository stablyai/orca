import { MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'
import type { ColorProbe } from './plugin-theme-tokens'
import { accentInkContrast, accentInkHex } from '../../../../shared/color/accent-ink'
import { contrastRatio } from '../../../../shared/color/rgba-contrast'

const THEME_ACCENT = '--text-link'
const THEME_ACCENT_FOREGROUND = '--theme-accent-foreground'
/** The fill of a theme-accent button; main.css falls back to the accent when it is unset. */
export const THEME_ACCENT_FILL_TOKEN = '--theme-accent-fill'

/**
 * The fill and label for a theme's accent button, for a theme whose tokens already passed
 * safePluginThemeTokens. The label follows the accent: the theme's own label when it reads on the
 * accent, else whichever of near-black or near-white reads better. When no label reaches 4.5:1 on
 * the accent, only the button falls back to the built-in accent and label; the theme's accent
 * still colors its links everywhere else.
 */
export function themeAccentButtonTokens(
  tokens: Readonly<Record<string, string>>,
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): Record<string, string> {
  const accent = tokens[THEME_ACCENT] ? probe(tokens[THEME_ACCENT]) : null
  // Why: with no accent of its own, the theme's label (if any) already passed the contrast check
  // against the built-in accent, which main.css paints.
  if (!accent) {
    return {}
  }
  if (accent[3] === 1) {
    const ownLabel = tokens[THEME_ACCENT_FOREGROUND]
    const ownLabelColor = ownLabel ? probe(ownLabel) : null
    if (ownLabelColor?.[3] === 1 && contrastRatio(accent, ownLabelColor) >= MIN_TEXT_CONTRAST) {
      return {}
    }
    if (accentInkContrast(accent) >= MIN_TEXT_CONTRAST) {
      return { [THEME_ACCENT_FOREGROUND]: accentInkHex(accent) }
    }
  }
  const builtInAccent = builtIns[THEME_ACCENT]
  const builtInLabel = builtIns[THEME_ACCENT_FOREGROUND]
  return builtInAccent && builtInLabel
    ? { [THEME_ACCENT_FILL_TOKEN]: builtInAccent, [THEME_ACCENT_FOREGROUND]: builtInLabel }
    : {}
}
