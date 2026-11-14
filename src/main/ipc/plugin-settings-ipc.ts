import { ipcMain } from 'electron'
import { z } from 'zod'
import { isQualifiedPluginKey } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginService } from '../plugins/plugin-service'
import {
  readPluginDeclaredSettings,
  writePluginDeclaredSetting
} from '../plugins/plugin-declared-settings'

const pluginKeySchema = z.string().refine(isQualifiedPluginKey, 'invalid plugin key')
const readArgsSchema = z.object({ pluginKey: pluginKeySchema }).strict()
const writeArgsSchema = z
  .object({ pluginKey: pluginKeySchema, key: z.string().min(1).max(64), value: z.json() })
  .strict()

/** The plugin settings Orca's Settings page shows and edits (`contributes.settings`). */
export function registerPluginSettingsHandlers(pluginService: PluginService): void {
  const host = () => ({
    findValidPlugin: (pluginKey: string) => pluginService.findValidPlugin(pluginKey),
    userDataPath: pluginService.options.userDataPath,
    dataChanged: (pluginKey: string, key: string) =>
      pluginService.panelBridge.dataChanged(pluginKey, 'settings', key)
  })
  ipcMain.handle('plugins:getSettings', async (_event, args: unknown) => {
    await pluginService.whenReady()
    return readPluginDeclaredSettings(host(), readArgsSchema.parse(args).pluginKey)
  })
  ipcMain.handle('plugins:setSetting', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const { pluginKey, key, value } = writeArgsSchema.parse(args)
    return writePluginDeclaredSetting(host(), pluginKey, key, value)
  })
}
