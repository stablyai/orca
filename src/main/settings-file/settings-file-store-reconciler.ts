import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { listPresentPortableKeys, type SettingsFileValues } from './settings-file-document'
import { reconcileSettingsFile } from './settings-file-reconcile'
import type { SettingsFileStore } from './settings-file-sync-types'

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function createStoreReconciler(args: {
  store: SettingsFileStore
  defaults: GlobalSettings
  getDirtyKeys: () => ReadonlySet<string>
}): {
  reconcile: (values: SettingsFileValues) => void
  recordSeenKeys: (values: SettingsFileValues) => void
} {
  const { store, defaults, getDirtyKeys } = args
  return {
    reconcile: (values) => {
      const { updates, presentKeys } = reconcileSettingsFile({
        values,
        current: store.getSettings(),
        defaults,
        dirtyKeys: getDirtyKeys()
      })
      const hasUpdates = Object.keys(updates).length > 0
      if (
        !hasUpdates &&
        sameList(store.getSettings().settingsFileLastSeenKeys ?? [], presentKeys)
      ) {
        return
      }
      store.updateSettings(
        { ...updates, settingsFileLastSeenKeys: presentKeys },
        { notifyListeners: hasUpdates, origin: 'settings-file' }
      )
    },
    recordSeenKeys: (values) => {
      const seen = listPresentPortableKeys(values)
      if (!sameList(store.getSettings().settingsFileLastSeenKeys ?? [], seen)) {
        store.updateSettings({ settingsFileLastSeenKeys: seen }, { origin: 'settings-file' })
      }
    }
  }
}
