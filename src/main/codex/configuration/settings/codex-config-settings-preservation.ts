import { parse } from 'smol-toml'
import { removePromotedSettingsFromContent } from './codex-config-settings-removal'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion,
  type CodexRegistrationPromotion
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
    result = applyHeldRegistrations(
      result,
      planCodexRegistrationPromotion(
        configs.runtimeConfig,
        configs.systemConfig,
        plan.heldRegistrationBaseline
      ),
      configs.systemConfig
    )
  }
  return { content: result, keys }
}

function applyHeldRegistrations(
  content: string,
  promotions: CodexRegistrationPromotion[],
  systemConfig: string
): string {
  const fieldEdits = promotions.filter((promotion) => promotion.kind !== 'append')
  if (fieldEdits.length === promotions.length) {
    return applyCodexRegistrationPromotions(content, promotions)
  }
  const source = parseTomlOrNull(systemConfig)
  // Inline and dotted-key spellings escape the table-header scan; appending would define a table twice.
  const appends = promotions.filter((promotion) => {
    if (promotion.kind !== 'append' || !source) {
      return false
    }
    const [root, ...name] = promotion.key.split(':')
    const table = source[root!]
    return !(typeof table === 'object' && table !== null && Object.hasOwn(table, name.join(':')))
  })
  const withAppends = applyCodexRegistrationPromotions(content, [...appends, ...fieldEdits])
  // An inline root table (`plugins = {}`) cannot be extended; never publish a config Codex rejects.
  return appends.length > 0 && !parseTomlOrNull(withAppends)
    ? applyCodexRegistrationPromotions(content, fieldEdits)
    : withAppends
}

function parseTomlOrNull(content: string): Record<string, unknown> | null {
  try {
    return parse(content)
  } catch {
    return null
  }
}
