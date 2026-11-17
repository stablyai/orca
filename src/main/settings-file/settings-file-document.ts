import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import {
  isPortableSettingsKey,
  isValidPortableSettingValue
} from '../../shared/settings/settings-file/portable-setting-validation'
import type { IgnoredSettingsKey } from '../../shared/settings/settings-file/settings-file-status-types'
import { SETTINGS_KEY_PORTABILITY } from '../../shared/settings/settings-file/settings-key-portability'

export type SettingsFileValues = Record<string, unknown>

/** Layout of the file as the user wrote it, so our rewrites do not reformat it. */
export type SettingsFileFormat = {
  bom: boolean
  indent: string | number
  trailingNewline: boolean
}

export type ParsedSettingsFile =
  | { kind: 'ok'; values: SettingsFileValues; format: SettingsFileFormat }
  | { kind: 'invalid'; message: string }

const BYTE_ORDER_MARK = '\uFEFF'
const DEFAULT_INDENT = 2
const MAX_INDENT_LENGTH = 10

export type ExtractedPortableSettings = {
  valid: Partial<GlobalSettings>
  ignored: IgnoredSettingsKey[]
}

function isRecord(value: unknown): value is SettingsFileValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detectIndent(body: string): string | number {
  const leading = /^([ \t]+)\S/m.exec(body)?.[1]
  if (!leading) {
    return DEFAULT_INDENT
  }
  return leading.startsWith('\t') ? '\t' : ' '.repeat(Math.min(leading.length, MAX_INDENT_LENGTH))
}

export function parseSettingsFileText(text: string): ParsedSettingsFile {
  const bom = text.startsWith(BYTE_ORDER_MARK)
  const body = bom ? text.slice(BYTE_ORDER_MARK.length) : text
  if (body.trim() === '') {
    return {
      kind: 'ok',
      values: {},
      format: { bom, indent: DEFAULT_INDENT, trailingNewline: true }
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(parsed)) {
    return { kind: 'invalid', message: 'Top-level value must be a JSON object' }
  }
  return {
    kind: 'ok',
    values: parsed,
    format: { bom, indent: detectIndent(body), trailingNewline: body.endsWith('\n') }
  }
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

// Every portable key the file holds, valid or not, so removing a key with a bad value still resets it.
export function listPresentPortableKeys(values: SettingsFileValues): string[] {
  return Object.keys(values).filter(isPortableSettingsKey)
}

const DEFAULT_FORMAT: SettingsFileFormat = {
  bom: false,
  indent: DEFAULT_INDENT,
  trailingNewline: true
}

// An undefined update means "unset", which JSON can only express by omitting the key.
export function serializeWithUpdates(
  values: SettingsFileValues,
  updates: Record<string, unknown>,
  format: SettingsFileFormat = DEFAULT_FORMAT
): string {
  const next: SettingsFileValues = { ...values }
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  const json = JSON.stringify(next, null, format.indent)
  return `${format.bom ? BYTE_ORDER_MARK : ''}${json}${format.trailingNewline ? '\n' : ''}`
}
