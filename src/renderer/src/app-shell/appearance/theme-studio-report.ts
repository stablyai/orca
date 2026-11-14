import { completePluginAppThemeTokens } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { formatThemeColor } from '../../../../shared/color/oklch-color-transform'
import { contrastRatio, readableOn, type Rgba } from '../../../../shared/color/rgba-contrast'
import {
  THEME_STUDIO_MODES,
  type ThemeStudioDraft,
  type ThemeStudioMode
} from '../../../../shared/theme-studio/theme-studio-draft'
import type {
  ThemeStudioIssue,
  ThemeStudioReport
} from '../../../../shared/theme-studio/theme-studio-protocol'
import {
  evaluatePluginThemeTokens,
  type ColorProbe,
  type PluginThemeTokenDrop
} from './plugin-theme-tokens'

const BLACK: Rgba = [0, 0, 0, 1]
const WHITE: Rgba = [255, 255, 255, 1]
// Why a margin: a fix exactly at the minimum can round under it once written as hex.
const FIX_MARGIN = 0.15
const SAFE_BORDER_ALPHA = 0.12

const isLight = (color: Rgba): boolean => contrastRatio(color, BLACK) > contrastRatio(color, WHITE)
const round = (ratio: number): number => Math.round(ratio * 100) / 100

/** Moves `color` toward black or white until it reads on `against`. */
function readableFix(
  token: string,
  color: Rgba,
  against: Rgba,
  min: number
): ThemeStudioIssue['fix'] {
  const opaque: Rgba = [color[0], color[1], color[2], 1]
  const fixed = readableOn(opaque, [against], isLight(against), min + FIX_MARGIN)
  return { token, value: formatThemeColor(fixed), ratio: round(contrastRatio(fixed, against)) }
}

function issueFor(
  drop: PluginThemeTokenDrop,
  owned: Readonly<Record<string, string>>,
  probe: ColorProbe
): ThemeStudioIssue {
  switch (drop.kind) {
    case 'invalid':
      return { problem: 'invalid', tokens: [drop.token] }
    case 'border-alpha': {
      const color = probe(drop.value)
      return {
        problem: 'border-alpha',
        tokens: [drop.token],
        min: drop.min,
        ...(color && owned[drop.token]
          ? {
              fix: {
                token: drop.token,
                value: formatThemeColor([color[0], color[1], color[2], SAFE_BORDER_ALPHA])
              }
            }
          : {})
      }
    }
    case 'ring':
      return {
        problem: 'ring',
        tokens: [drop.token],
        surface: drop.surface,
        ratio: round(drop.ratio),
        min: drop.min,
        ...(owned[drop.token]
          ? { fix: readableFix(drop.token, drop.ringColor, drop.surfaceColor, drop.min) }
          : {})
      }
    case 'contrast': {
      // Why text first: moving the text keeps the theme's surfaces, which carry its look.
      const fix =
        drop.ratio === null
          ? undefined
          : owned[drop.text] && drop.textColor[3] === 1
            ? readableFix(drop.text, drop.textColor, drop.surfaceColor, drop.min)
            : owned[drop.surface]
              ? readableFix(drop.surface, drop.surfaceColor, drop.textColor, drop.min)
              : undefined
      return {
        problem: 'contrast',
        tokens: [...drop.dropped],
        text: drop.text,
        surface: drop.surface,
        ratio: drop.ratio === null ? null : round(drop.ratio),
        min: round(drop.min),
        ...(fix ? { fix } : {})
      }
    }
  }
}

/** What the contrast check drops from each mode of a draft, with a passing value for each. */
export function themeStudioReport(input: {
  revision: number
  draft: ThemeStudioDraft
  shownMode: ThemeStudioMode
  builtIns: (mode: ThemeStudioMode) => Record<string, string>
  probe: ColorProbe
}): ThemeStudioReport {
  const modes = THEME_STUDIO_MODES.flatMap((mode) => {
    const variant = input.draft[mode]
    if (!variant) {
      return []
    }
    const { drops } = evaluatePluginThemeTokens(
      completePluginAppThemeTokens(variant.tokens),
      mode,
      input.builtIns(mode),
      input.probe
    )
    return [
      {
        mode,
        shown: mode === input.shownMode,
        issues: drops.map((drop) => issueFor(drop, variant.tokens, input.probe))
      }
    ]
  })
  return { revision: input.revision, modes }
}
