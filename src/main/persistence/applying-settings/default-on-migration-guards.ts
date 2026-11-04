import type { GlobalSettings } from '../../../shared/global-settings-types'

// Each setting whose default flipped once, paired with its one-shot migration guard.
const DEFAULT_ON_MIGRATION_GUARDS = [
  ['terminalTuiScrollSensitivity', 'terminalTuiScrollSensitivityDefaultedToOne'],
  ['autoRenameBranchFromWork', 'autoRenameBranchFromWorkDefaultedOn'],
  ['pluginSystemEnabled', 'pluginSystemDefaultedOn']
] as const satisfies readonly (readonly [keyof GlobalSettings, keyof GlobalSettings])[]

/** Explicit writes (or attempts to clear a guard) keep the guard set so later choices stick. */
export function stampDefaultOnMigrationGuards(
  updates: Partial<GlobalSettings>,
  sanitizedUpdates: Partial<GlobalSettings>
): void {
  for (const [setting, guard] of DEFAULT_ON_MIGRATION_GUARDS) {
    if (setting in updates || guard in updates) {
      sanitizedUpdates[guard] = true
    }
  }
}
