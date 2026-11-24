import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import {
  normalizeTaskProviderSettings,
  type TaskProvider
} from '../../../../shared/work-items/task-providers'

// Each provider added after the original set, paired with the guard that makes its tab visible once.
const VISIBILITY_MIGRATIONS = [
  ['jira', 'visibleTaskProvidersDefaultedForJira'],
  ['clickup', 'visibleTaskProvidersDefaultedForClickUp']
] as const satisfies readonly (readonly [TaskProvider, keyof GlobalSettings])[]

/** Normalizes saved task-provider settings and shows each newer provider once, so a later opt-out survives. */
export function migrateLoadedTaskProviderSettings(settings: Partial<GlobalSettings> | undefined): {
  taskProviderSettings: Pick<GlobalSettings, 'defaultTaskSource' | 'visibleTaskProviders'>
  needsSave: boolean
} {
  const normalized = normalizeTaskProviderSettings({
    visibleTaskProviders: settings?.visibleTaskProviders,
    defaultTaskSource: settings?.defaultTaskSource
  })
  let visibleTaskProviders = normalized.visibleTaskProviders
  let needsSave = false
  for (const [provider, guard] of VISIBILITY_MIGRATIONS) {
    if (settings?.[guard] === true) {
      continue
    }
    needsSave = true
    if (!visibleTaskProviders.includes(provider)) {
      visibleTaskProviders = [...visibleTaskProviders, provider]
    }
  }
  return {
    taskProviderSettings: normalizeTaskProviderSettings({
      visibleTaskProviders,
      defaultTaskSource: normalized.defaultTaskSource
    }),
    needsSave
  }
}
