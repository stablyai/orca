import {
  pickPortableSettings,
  type CheckedPortableSettings,
  portableSettingChanges,
  readPortableSettings,
  type PortableSettings,
  type PortableSettingsImportResult,
  type StoredPortableSettings
} from '../../../../shared/portable-settings'

/** Writes settings the way the desktop Settings window does, so theme, menus and hooks follow. */
export type DesktopSettingsWriter = (updates: PortableSettings) => Promise<unknown>

type PortableSettingsStore = {
  getSettings(): StoredPortableSettings
  updateSettings?: (updates: PortableSettings, options: { notifyListeners: boolean }) => unknown
} | null

/** Also names the stored selections this Orca keeps back, such as a custom terminal theme. */
export function exportPortableSettings(store: PortableSettingsStore): CheckedPortableSettings {
  if (!store?.getSettings) {
    throw new Error('runtime_unavailable')
  }
  return pickPortableSettings(store.getSettings())
}

export async function importPortableSettings(
  store: PortableSettingsStore,
  desktopWriter: DesktopSettingsWriter | null,
  args: { settings: Record<string, unknown>; dryRun?: boolean }
): Promise<PortableSettingsImportResult> {
  if (!store?.getSettings || !store.updateSettings) {
    throw new Error('runtime_unavailable')
  }
  const { settings, skipped } = readPortableSettings(args.settings)
  const changes = portableSettingChanges(
    pickPortableSettings(store.getSettings()).settings,
    settings
  )
  const changed = Object.keys(changes)
  if (!args.dryRun && changed.length > 0) {
    if (desktopWriter) {
      await desktopWriter(changes)
    } else {
      store.updateSettings(changes, { notifyListeners: true })
    }
  }
  return { changed, skipped }
}
