import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { isPortableSettingsKey } from '../../shared/settings/settings-file/portable-setting-validation'
import { PORTABLE_SETTINGS_KEYS } from '../../shared/settings/settings-file/settings-key-portability'
import {
  extractPortableSettings,
  listPresentPortableKeys,
  type SettingsFileValues
} from './settings-file-document'

export type SettingsFileReconciliation = {
  /** Store changes implied by the file; empty when the store already agrees. */
  updates: Partial<GlobalSettings>
  /** Portable keys the file holds, to remember for the next removal check. */
  presentKeys: string[]
}

function assignSetting<K extends keyof GlobalSettings>(
  target: Partial<GlobalSettings>,
  key: K,
  value: GlobalSettings[K]
): void {
  target[key] = value
}

// The file wins for every key except those the UI changed and has not yet flushed.
export function reconcileSettingsFile(args: {
  values: SettingsFileValues
  current: GlobalSettings
  defaults: GlobalSettings
  dirtyKeys: ReadonlySet<string>
}): SettingsFileReconciliation {
  const { values, current, defaults, dirtyKeys } = args
  const { valid } = extractPortableSettings(values)
  const updates: Partial<GlobalSettings> = {}
  for (const key of PORTABLE_SETTINGS_KEYS) {
    if (dirtyKeys.has(key) || !Object.hasOwn(valid, key) || Object.is(valid[key], current[key])) {
      continue
    }
    assignSetting(updates, key, valid[key])
  }
  // A key that was in the file at the last read and is gone now means "back to default".
  for (const key of current.settingsFileLastSeenKeys ?? []) {
    if (
      !isPortableSettingsKey(key) ||
      dirtyKeys.has(key) ||
      Object.hasOwn(values, key) ||
      Object.is(current[key], defaults[key])
    ) {
      continue
    }
    assignSetting(updates, key, defaults[key])
  }
  return { updates, presentKeys: listPresentPortableKeys(values) }
}

// What "create from current settings" writes: only values that differ from the defaults.
export function collectNonDefaultPortableSettings(
  current: GlobalSettings,
  defaults: GlobalSettings
): Record<string, unknown> {
  const document: Record<string, unknown> = {}
  for (const key of PORTABLE_SETTINGS_KEYS) {
    if (current[key] !== undefined && !Object.is(current[key], defaults[key])) {
      document[key] = current[key]
    }
  }
  return document
}
