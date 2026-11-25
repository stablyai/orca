import { resolveUntrackedCodexSetting } from './config-settings-conflict-resolution'
import type { CodexSettingsBaseline, CodexSettingsConflict } from './config-settings-baseline'
import {
  PROMOTED_STRUCTURED_KEYS,
  type TopLevelSettingValue
} from '../toml/config-toml-promoted-setting-values'

export type PromotionCollectionContext = {
  baseline: CodexSettingsBaseline
  runtimeValues: ReadonlyMap<string, TopLevelSettingValue>
  systemValues: ReadonlyMap<string, TopLevelSettingValue>
  updates: Map<string, string>
  conflicts: Map<string, CodexSettingsConflict>
  runtimeValuesToPreserve: Map<string, string | null>
}

export function collectPromotionChanges(context: PromotionCollectionContext): void {
  for (const key of PROMOTED_STRUCTURED_KEYS) {
    const runtimeRaw = getComparableRaw(context.runtimeValues.get(key))
    const systemRaw = getComparableRaw(context.systemValues.get(key))
    if (runtimeRaw === undefined || systemRaw === undefined) {
      continue
    }

    const existingConflict = context.baseline.conflicts.get(key)
    if (existingConflict || !context.baseline.settings.has(key)) {
      const resolution = resolveUntrackedCodexSetting(runtimeRaw, systemRaw, existingConflict)
      if (resolution.action === 'promote-runtime') {
        context.updates.set(key, resolution.raw)
      } else if (resolution.action === 'preserve') {
        // Without an ancestor, preserve both values until a later edit resolves the conflict.
        context.conflicts.set(key, resolution.conflict)
        context.runtimeValuesToPreserve.set(key, runtimeRaw)
      }
      continue
    }

    if (runtimeRaw === null || runtimeRaw === context.baseline.settings.get(key)) {
      continue
    }
    // Canonical edits win when both sides changed from the known baseline.
    if (systemRaw !== context.baseline.settings.get(key)) {
      continue
    }
    context.updates.set(key, runtimeRaw)
  }
}

function getComparableRaw(value: TopLevelSettingValue | undefined): string | null | undefined {
  if (!value) {
    return null
  }
  return value.multiline ? undefined : value.raw
}
