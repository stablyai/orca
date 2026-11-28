import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { isQualifiedPluginKey } from '../../../shared/plugins/frames/plugin-tab-key'
import type { PluginService } from '../../plugins/plugin-service'
import {
  readPluginDeclaredSettings,
  writePluginDeclaredSetting
} from '../../plugins/storage/plugin-declared-settings'

const pluginKeySchema = lazyZodSchema(() =>
  z.string().refine(isQualifiedPluginKey, 'invalid plugin key')
)
const readArgsSchema = lazyZodSchema(() => z.object({ pluginKey: pluginKeySchema }).strict())
const writeArgsSchema = lazyZodSchema(() =>
  z.object({ pluginKey: pluginKeySchema, key: z.string().min(1).max(64), value: z.json() }).strict()
)

/** The plugin settings Orca's Settings page shows and edits (`contributes.settings`). */
export function registerPluginSettingsHandlers(
  pluginService: PluginService,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  const host = () => ({
    findValidPlugin: (pluginKey: string) => pluginService.findValidPlugin(pluginKey),
    userDataPath: pluginService.options.userDataPath,
    dataChanged: (pluginKey: string, key: string) =>
      pluginService.panelBridge.dataChanged(pluginKey, 'settings', key)
  })
  ipc.handle('plugins:getSettings', async (_event, args: unknown) => {
    await pluginService.whenReady()
    return readPluginDeclaredSettings(host(), readArgsSchema.parse(args).pluginKey)
  })
  ipc.handle('plugins:setSetting', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const { pluginKey, key, value } = writeArgsSchema.parse(args)
    return writePluginDeclaredSetting(host(), pluginKey, key, value)
  })
}
