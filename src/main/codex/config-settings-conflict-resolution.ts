import type { CodexSettingsBaseline, CodexSettingsConflict } from './config-settings-baseline'

export type CodexSettingsConflictResolution =
  | { action: 'aligned' }
  | { action: 'preserve'; conflict: CodexSettingsConflict }
  | { action: 'promote-runtime'; raw: string }
  | { action: 'use-system' }

export function resolveUntrackedCodexSetting(
  runtime: string | null,
  system: string | null,
  existingConflict?: CodexSettingsConflict
): CodexSettingsConflictResolution {
  if (runtime === system) {
    return { action: 'aligned' }
  }
  if (!existingConflict) {
    return { action: 'preserve', conflict: { runtime, system } }
  }

  const runtimeChanged = runtime !== existingConflict.runtime
  const systemChanged = system !== existingConflict.system
  if (runtimeChanged && !systemChanged) {
    // Why: steady-state promotion intentionally does not propagate deletions.
    return runtime === null ? { action: 'use-system' } : { action: 'promote-runtime', raw: runtime }
  }
  if (!runtimeChanged && systemChanged) {
    return { action: 'use-system' }
  }
  if (runtimeChanged && systemChanged) {
    // Why: two new divergent values remain ambiguous; re-anchor their content without blocking other keys.
    return { action: 'preserve', conflict: { runtime, system } }
  }
  return { action: 'preserve', conflict: existingConflict }
}

export type CodexPromotedSettingValue = {
  raw: string
  multiline: boolean
}

export function collectCodexSettingPromotionChanges(context: {
  keys: readonly string[]
  baseline: CodexSettingsBaseline
  runtimeValues: ReadonlyMap<string, CodexPromotedSettingValue>
  systemValues: ReadonlyMap<string, CodexPromotedSettingValue>
  updates: Map<string, string>
  conflicts: Map<string, CodexSettingsConflict>
  runtimeValuesToPreserve: Map<string, string | null>
}): void {
  for (const key of context.keys) {
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
        context.conflicts.set(key, resolution.conflict)
        context.runtimeValuesToPreserve.set(key, runtimeRaw)
      }
      continue
    }

    const baselineRaw = context.baseline.settings.get(key)
    if (runtimeRaw !== null && runtimeRaw !== baselineRaw && systemRaw === baselineRaw) {
      context.updates.set(key, runtimeRaw)
    }
  }
}

function getComparableRaw(value: CodexPromotedSettingValue | undefined): string | null | undefined {
  if (!value) {
    return null
  }
  return value.multiline ? undefined : value.raw
}
