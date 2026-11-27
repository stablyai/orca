import type { CommandHandler } from '../dispatch/dispatch'
import type { PluginDeclaredSettingsSnapshot } from '../../shared/plugins/contributions/plugin-settings-values'
import type { PluginJsonValue } from '../../shared/plugins/workers/plugin-host-api-storage-schemas'
import { RuntimeClientError } from '../runtime/connection/types'
import { printPluginResult, requirePluginPathArg } from './plugin-cli-output'
import { callPlugins, requirePluginKey } from './plugin-runtime'

export const PLUGIN_SETTINGS_HANDLERS: Record<string, CommandHandler> = {
  'plugin settings get': async (ctx) => {
    const result = await callPlugins<PluginDeclaredSettingsSnapshot & { pluginKey: string }>(
      ctx,
      'plugins.getSettings',
      {
        pluginKey: requirePluginKey(ctx),
        key: ctx.flags.get('key')
      }
    )
    printPluginResult(
      ctx,
      result,
      result.settings.length === 0
        ? `${result.pluginKey} declares no settings.`
        : result.settings
            .map(
              (setting) =>
                `${setting.key} = ${Object.hasOwn(result.values, setting.key) ? JSON.stringify(result.values[setting.key]) : '(unset)'}`
            )
            .join('\n')
    )
  },
  'plugin settings set': async (ctx) => {
    const pluginKey = requirePluginKey(ctx)
    const key = requirePluginPathArg(ctx, 'key')
    const raw = requirePluginPathArg(ctx, 'value')
    let value: PluginJsonValue
    try {
      value = JSON.parse(raw)
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('non-finite number')
      }
    } catch {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass a JSON value, such as false, 0, a quoted string (\'"text"\'), or null to restore the default.'
      )
    }
    const result = await callPlugins<{ pluginKey: string; key: string; value: PluginJsonValue }>(
      ctx,
      'plugins.setSetting',
      { pluginKey, key, value }
    )
    printPluginResult(
      ctx,
      result,
      `${result.pluginKey}: ${result.key} = ${JSON.stringify(result.value)}${value === null ? ' (default restored)' : ''}`
    )
  }
}
