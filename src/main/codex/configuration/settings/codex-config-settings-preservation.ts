import { removePromotedSettingsFromContent } from './codex-config-settings-removal'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion
} from './config-plugin-registration-promotion'
import type { CodexSettingsPromotionPlan } from './config-settings-promotion'

/** Re-apply runtime edits the mirrored source does not hold yet. */
export function preservePendingRuntimeEdits(
  content: string,
  plan: Pick<CodexSettingsPromotionPlan, 'runtimeValuesToPreserve' | 'heldRegistrationBaseline'>,
  configs: { runtimeConfig: string; systemConfig: string }
): { content: string; keys: ReadonlySet<string> } {
  let result = content
  const keys = new Set<string>()
  for (const [key, raw] of plan.runtimeValuesToPreserve) {
    const previous = result
    result =
      raw === null
        ? removePromotedSettingsFromContent(result, new Set([key]))
        : upsertPromotedSettingsInContent(result, new Map([[key, raw]]))
    if (result !== previous) {
      keys.add(key)
    }
  }
  if (plan.heldRegistrationBaseline) {
    // A source Orca never writes keeps runtime plugin edits in the managed copy instead.
    result = applyCodexRegistrationPromotions(
      result,
      planCodexRegistrationPromotion(
        configs.runtimeConfig,
        configs.systemConfig,
        plan.heldRegistrationBaseline
      )
    )
  }
  return { content: result, keys }
}
