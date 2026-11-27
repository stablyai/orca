import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { TaskProvider } from '../../../../shared/work-items/task-providers'

// Shows It's a Plan once for profiles saved before it existed; a later hide sticks.
export function migrateItsaplanVisibility(
  providers: readonly TaskProvider[],
  settings: Partial<GlobalSettings> | undefined
): { providers: TaskProvider[]; needsSave: boolean } {
  const defaulted = settings?.visibleTaskProvidersDefaultedForItsaplan === true
  return {
    providers:
      defaulted || providers.includes('itsaplan') ? [...providers] : [...providers, 'itsaplan'],
    needsSave: !defaulted
  }
}
