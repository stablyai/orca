import type { CodexSettingsConflict } from './config-settings-baseline'

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
