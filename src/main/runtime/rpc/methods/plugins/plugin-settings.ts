import { defineMethod, InvalidArgumentError } from '../../core'
import {
  PluginGetSettingsParams,
  PluginSetSettingParams
} from '../../../../../shared/rpc-contract/plugins/plugins-params'
import {
  pluginDeclaredSettingsHost,
  readPluginDeclaredSettings,
  writePluginDeclaredSetting
} from '../../../../plugins/storage/plugin-declared-settings'
import { requirePluginService } from './plugins'

async function declaredSettingsHost(pluginKey: string) {
  const service = requirePluginService()
  await service.whenReady()
  if (!service.findValidPlugin(pluginKey)) {
    throw new InvalidArgumentError(`plugin ${pluginKey} is not installed or loaded`)
  }
  return pluginDeclaredSettingsHost(service)
}

export const PLUGIN_SETTINGS_METHODS = [
  defineMethod({
    name: 'plugins.getSettings',
    permission: 'host-admin',
    params: PluginGetSettingsParams,
    handler: async ({ pluginKey, key }) => {
      const host = await declaredSettingsHost(pluginKey)
      const snapshot = readPluginDeclaredSettings(host, pluginKey) ?? { settings: [], values: {} }
      if (key === undefined) {
        return { pluginKey, ...snapshot }
      }
      const setting = snapshot.settings.find((entry) => entry.key === key)
      if (!setting) {
        throw new InvalidArgumentError(`plugin ${pluginKey} declares no setting ${key}`)
      }
      return {
        pluginKey,
        settings: [setting],
        values: Object.hasOwn(snapshot.values, key) ? { [key]: snapshot.values[key] } : {}
      }
    }
  }),
  defineMethod({
    name: 'plugins.setSetting',
    permission: 'host-admin',
    params: PluginSetSettingParams,
    handler: async ({ pluginKey, key, value }) => {
      const host = await declaredSettingsHost(pluginKey)
      const result = writePluginDeclaredSetting(host, pluginKey, key, value)
      if (!result.ok) {
        throw new InvalidArgumentError(result.error)
      }
      const snapshot = readPluginDeclaredSettings(host, pluginKey)
      return {
        pluginKey,
        key,
        value: snapshot && Object.hasOwn(snapshot.values, key) ? snapshot.values[key] : null
      }
    }
  })
]
