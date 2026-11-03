import type { PluginJsonValue } from '../../shared/plugins/workers/plugin-host-api'
import { pluginSettingValueIssue } from '../../shared/plugins/contributions/plugin-settings-contribution'
import {
  pluginSettingDefaults,
  type PluginDeclaredSettingsSnapshot
} from '../../shared/plugins/contributions/plugin-settings-values'
import { getPluginsDataDir, type ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginKvStore } from './plugin-storage-store'

type SettingsHost = {
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  userDataPath: string
  /** Tells open panels and a running worker that `key` changed. */
  dataChanged: (pluginKey: string, key: string) => void
}

function store(host: SettingsHost, pluginKey: string): PluginKvStore {
  return new PluginKvStore(getPluginsDataDir(host.userDataPath), pluginKey, 'settings.json')
}

/** What Orca's Settings shows under a plugin; null when it declares none. */
export function readPluginDeclaredSettings(
  host: SettingsHost,
  pluginKey: string
): PluginDeclaredSettingsSnapshot | null {
  const settings = host.findValidPlugin(pluginKey)?.manifest.contributes.settings ?? []
  if (settings.length === 0) {
    return null
  }
  const stored = store(host, pluginKey).getAll()
  const values = pluginSettingDefaults(settings)
  for (const setting of settings) {
    if (Object.hasOwn(stored, setting.key)) {
      values[setting.key] = stored[setting.key]
    }
  }
  return { settings, values }
}

/** The person's edit in Settings; `null` goes back to the default. Only declared keys. */
export function writePluginDeclaredSetting(
  host: SettingsHost,
  pluginKey: string,
  key: string,
  value: PluginJsonValue
): { ok: true } | { ok: false; error: string } {
  const setting = host
    .findValidPlugin(pluginKey)
    ?.manifest.contributes.settings.find((entry) => entry.key === key)
  if (!setting) {
    return { ok: false, error: `the plugin declares no setting ${key}` }
  }
  const settings = store(host, pluginKey)
  if (value === null) {
    settings.delete(key)
  } else {
    const issue = pluginSettingValueIssue(setting, value)
    if (issue) {
      return { ok: false, error: `${setting.title} ${issue}` }
    }
    const written = settings.set(key, value)
    if (!written.ok) {
      return written
    }
  }
  host.dataChanged(pluginKey, key)
  return { ok: true }
}
