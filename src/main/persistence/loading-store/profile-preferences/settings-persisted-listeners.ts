import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { SettingsUpdateOrigin } from '../../applying-settings/settings-update'

export type SettingsPersistedListener = (
  changed: Partial<GlobalSettings>,
  origin: SettingsUpdateOrigin | undefined
) => void

export function notifySettingsPersistedListeners(
  listeners: Iterable<SettingsPersistedListener>,
  changed: Partial<GlobalSettings>,
  origin: SettingsUpdateOrigin | undefined
): void {
  for (const listener of listeners) {
    // The change is already applied; one failing subscriber must not fail the update or starve the rest.
    try {
      listener(changed, origin)
    } catch (error) {
      console.error('[preferences] settings persisted listener failed:', error)
    }
  }
}

/** Reports a committed durable write, minus values a newer update replaced mid-write (that update reported its own). */
export function notifyStillCurrentSettings(
  listeners: Iterable<SettingsPersistedListener>,
  committed: Partial<GlobalSettings>,
  current: GlobalSettings,
  origin: SettingsUpdateOrigin | undefined
): void {
  const currentEntries = new Map(Object.entries(current))
  const stillCurrent = Object.fromEntries(
    Object.entries(committed).filter(([key, value]) => Object.is(currentEntries.get(key), value))
  )
  if (Object.keys(stillCurrent).length > 0) {
    notifySettingsPersistedListeners(listeners, stillCurrent, origin)
  }
}
