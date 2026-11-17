import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { isValidPortableSettingValue } from '../../shared/settings/settings-file/portable-setting-validation'
import type { IgnoredSettingsKey } from '../../shared/settings/settings-file/settings-file-status-types'
import { SETTINGS_KEY_PORTABILITY } from '../../shared/settings/settings-file/settings-key-portability'

export type SettingsFileValues = Record<string, unknown>

export type ParsedSettingsFile =
  | { kind: 'ok'; values: SettingsFileValues }
  | { kind: 'invalid'; message: string }

export type ExtractedPortableSettings = {
  valid: Partial<GlobalSettings>
  ignored: IgnoredSettingsKey[]
}

function isRecord(value: unknown): value is SettingsFileValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSettingsFileText(text: string): ParsedSettingsFile {
  if (text.trim() === '') {
    return { kind: 'ok', values: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(parsed)) {
    return { kind: 'invalid', message: 'Top-level value must be a JSON object' }
  }
  return { kind: 'ok', values: parsed }
}

function isGlobalSettingsKey(key: string): key is keyof GlobalSettings {
  return Object.hasOwn(SETTINGS_KEY_PORTABILITY, key)
}

export function extractPortableSettings(values: SettingsFileValues): ExtractedPortableSettings {
  const validEntries: [string, unknown][] = []
  const ignored: IgnoredSettingsKey[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!isGlobalSettingsKey(key)) {
      ignored.push({ key, reason: 'unknown' })
    } else if (SETTINGS_KEY_PORTABILITY[key] !== 'portable') {
      ignored.push({ key, reason: 'not-portable' })
    } else if (isValidPortableSettingValue(key, value)) {
      validEntries.push([key, value])
    } else {
      ignored.push({ key, reason: 'invalid-value' })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every entry passed isValidPortableSettingValue for its own key.
  const valid = Object.fromEntries(validEntries) as Partial<GlobalSettings>
  return { valid, ignored }
}

// An undefined update means "unset", which JSON can only express by omitting the key.
export function serializeWithUpdates(
  values: SettingsFileValues,
  updates: Record<string, unknown>
): string {
  const next: SettingsFileValues = { ...values }
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  return `${JSON.stringify(next, null, 2)}\n`
}
