import { z } from 'zod'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import {
  parsePluginSettingValue,
  type PluginSettingValue
} from '../../shared/plugins/plugin-settings-contribution'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginKvStore } from './plugin-storage-store'

export type PluginUserSettingsDeps = {
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  pluginsDataDir: string
}

export const readPluginSettingsArgsSchema = z
  .object({ pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key') })
  .strict()

export const writePluginSettingArgsSchema = z
  .object({
    pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
    key: z.string().min(1).max(64),
    /** null resets the setting to the plugin's default. */
    value: z.union([z.string(), z.boolean(), z.null()])
  })
  .strict()

function declaredSettings(deps: PluginUserSettingsDeps, pluginKey: string) {
  const plugin = deps.findValidPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`plugin ${pluginKey} is not installed`)
  }
  return plugin.manifest.contributes.settings
}

function settingsStore(deps: PluginUserSettingsDeps, pluginKey: string): PluginKvStore {
  return new PluginKvStore(deps.pluginsDataDir, pluginKey, 'settings.json')
}

/** User-set values of the plugin's declared settings; undeclared or invalid stored values are hidden. */
export function readPluginUserSettings(
  deps: PluginUserSettingsDeps,
  rawArgs: unknown
): Record<string, PluginSettingValue> {
  const { pluginKey } = readPluginSettingsArgsSchema.parse(rawArgs)
  const stored = settingsStore(deps, pluginKey).getAll()
  const values: Record<string, PluginSettingValue> = {}
  for (const setting of declaredSettings(deps, pluginKey)) {
    const value = Object.hasOwn(stored, setting.key)
      ? parsePluginSettingValue(setting, stored[setting.key])
      : null
    if (value !== null) {
      values[setting.key] = value
    }
  }
  return values
}

/** Writes one declared setting from the Settings UI (not the worker), validated against its declaration. */
export function writePluginUserSetting(
  deps: PluginUserSettingsDeps,
  rawArgs: unknown
): Record<string, PluginSettingValue> {
  const { pluginKey, key, value } = writePluginSettingArgsSchema.parse(rawArgs)
  const setting = declaredSettings(deps, pluginKey).find((candidate) => candidate.key === key)
  if (!setting) {
    throw new Error(`plugin ${pluginKey} does not declare setting ${key}`)
  }
  const store = settingsStore(deps, pluginKey)
  if (value === null) {
    store.delete(key)
  } else {
    const parsed = parsePluginSettingValue(setting, value)
    if (parsed === null) {
      throw new Error(`invalid value for setting ${key}`)
    }
    const result = store.set(key, parsed)
    if (!result.ok) {
      throw new Error(result.error)
    }
  }
  return readPluginUserSettings(deps, { pluginKey })
}
