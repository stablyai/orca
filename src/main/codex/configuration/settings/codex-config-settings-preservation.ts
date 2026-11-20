import { removePromotedSettingsFromContent } from './codex-config-settings-removal'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion,
  readCodexRegistrationBaseline,
  type CodexRegistrationBaseline
} from './config-plugin-registration-promotion'
import type { CodexSettingsPromotionPlan } from './config-settings-promotion'

/** Reapply runtime values the promotion kept out of the canonical config onto the merged mirror. */
export function preserveRuntimeEdits(
  merged: string,
  runtimeConfig: string,
  systemConfig: string,
  plan: CodexSettingsPromotionPlan
): {
  content: string
  keys: ReadonlySet<string>
  registrationBaseline?: CodexRegistrationBaseline
} {
  const kept = plan.keptRuntimeRegistrations
  const withRegistrations = kept
    ? applyCodexRegistrationPromotions(
        merged,
        planCodexRegistrationPromotion(runtimeConfig, merged, kept)
      )
    : merged
  return {
    ...preserveRuntimeConflictValues(withRegistrations, plan.runtimeValuesToPreserve),
    // Kept tables must stay absent from the baseline, or the next pass reads them as mirrored.
    registrationBaseline: kept ? readCodexRegistrationBaseline(systemConfig) : undefined
  }
}

function preserveRuntimeConflictValues(
  content: string,
  values: ReadonlyMap<string, string | null>
): { content: string; keys: ReadonlySet<string> } {
  let result = content
  const keys = new Set<string>()
  for (const [key, raw] of values) {
    const previous = result
    result =
      raw === null
        ? removePromotedSettingsFromContent(result, new Set([key]))
        : upsertPromotedSettingsInContent(result, new Map([[key, raw]]))
    if (result !== previous) {
      keys.add(key)
    }
  }
  return { content: result, keys }
}
