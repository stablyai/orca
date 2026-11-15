import { completePluginAppThemeTokens } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import { cssColorProbe } from '../../shared/theme/css-color-probe'
import { splitUncheckedColors } from '../../shared/theme/css-color-unchecked'
import { evaluatePluginThemeTokens } from '../../shared/theme/theme-contrast-engine'
import { THEME_BUILT_IN_VALUES } from '../../shared/theme/theme-built-in-values.generated'
import type {
  ThemeStudioDraft,
  ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioPaint } from './theme-studio-fixes'

/**
 * What the renderer's contrast gate will leave unpainted for each of the draft's modes, worked
 * out here before painting from Orca's built-in table, so an answer exists even when no window
 * paints (no viewer, a timeout) and the renderer's own result can be checked against it.
 */
export function predictThemeStudioDrops(
  draft: ThemeStudioDraft | null
): Partial<Record<ThemeStudioMode, string[]>> {
  const predicted: Partial<Record<ThemeStudioMode, string[]>> = {}
  for (const mode of ['light', 'dark'] as const) {
    const variant = draft?.[mode]
    if (!variant) {
      continue
    }
    // Why without unchecked values: the renderer resolves them; guessing would log false drift.
    const tokens = splitUncheckedColors(completePluginAppThemeTokens(variant.tokens)).checked
    const { safe } = evaluatePluginThemeTokens(
      tokens,
      mode,
      THEME_BUILT_IN_VALUES[mode],
      cssColorProbe
    )
    predicted[mode] = Object.keys(tokens)
      .filter((token) => !(token in safe))
      .sort()
  }
  return predicted
}

/** Logs when the painted result differs from the prediction: the built-in table or the pure probe
 *  has drifted from the stylesheet or the browser, which `orca plugin validate` relies on. */
export function checkThemeStudioPrediction(
  paint: ThemeStudioPaint,
  predicted: Partial<Record<ThemeStudioMode, string[]>>
): void {
  if (paint.status !== 'painted' || !paint.mode) {
    return
  }
  const expected = predicted[paint.mode] ?? []
  const actual = [...paint.dropped].sort()
  if (expected.join(',') !== actual.join(',')) {
    console.warn('[theme-studio] contrast prediction differs from the paint', {
      mode: paint.mode,
      predicted: expected,
      painted: actual
    })
  }
}
