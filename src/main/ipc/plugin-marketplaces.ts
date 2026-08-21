import { ipcMain } from 'electron'
import { z } from 'zod'
import { PLUGIN_COMMIT_PATTERN } from '../../shared/plugins/plugin-install-lockfile'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { pluginMarketplaceGitSourceSchema } from '../../shared/plugins/plugin-marketplace'
import type { PluginMarketplaceInstaller } from '../plugins/plugin-marketplace-installer'
import type { PluginMarketplaceService } from '../plugins/plugin-marketplace-service'
import { PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN } from '../plugins/plugin-marketplace-store'
import type { PluginService } from '../plugins/plugin-service'

export type PluginMarketplaceHandlerServices = {
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
}

const sourceIdSchema = z.string().regex(PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN)
const removeMarketplaceSchema = z.strictObject({ sourceId: sourceIdSchema })
const refreshMarketplaceSchema = z.strictObject({ sourceId: sourceIdSchema.optional() })
const marketplacePluginSchema = z.strictObject({
  marketplaceSourceId: sourceIdSchema,
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
const installMarketplacePluginSchema = marketplacePluginSchema.extend({
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN)
})
const installedPluginSchema = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export function registerPluginMarketplaceHandlers(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices
): void {
  ipcMain.handle('plugins:listMarketplaces', () => services.marketplace.listSources())
  ipcMain.handle('plugins:addMarketplace', async (_event, args: unknown) => {
    const source = pluginMarketplaceGitSourceSchema.parse(args)
    return services.marketplace.addSource(source)
  })
  ipcMain.handle('plugins:removeMarketplace', async (_event, args: unknown) => {
    const { sourceId } = removeMarketplaceSchema.parse(args)
    await services.marketplace.removeSource(sourceId)
    return services.marketplace.listSources()
  })
  ipcMain.handle('plugins:refreshMarketplaces', async (_event, args: unknown) => {
    const { sourceId } = refreshMarketplaceSchema.parse(args ?? {})
    return sourceId
      ? [await services.marketplace.refreshSource(sourceId)]
      : services.marketplace.refreshAll()
  })
  ipcMain.handle('plugins:listMarketplacePlugins', () => services.marketplace.listPlugins())
  ipcMain.handle('plugins:previewMarketplacePlugin', async (_event, args: unknown) => {
    const parsed = marketplacePluginSchema.parse(args)
    return services.installer.preview(parsed.marketplaceSourceId, parsed.pluginKey)
  })
  ipcMain.handle('plugins:installMarketplacePlugin', async (_event, args: unknown) => {
    const result = await services.installer.install(installMarketplacePluginSchema.parse(args))
    if (result.ok) {
      await pluginService.refresh()
    }
    return result
  })
  ipcMain.handle('plugins:previewMarketplaceUpdate', async (_event, args: unknown) => {
    const { pluginKey } = installedPluginSchema.parse(args)
    return services.installer.previewInstalledUpdate(pluginKey)
  })
  ipcMain.handle('plugins:rollbackMarketplacePlugin', async (_event, args: unknown) => {
    const { pluginKey } = installedPluginSchema.parse(args)
    await pluginService.deactivatePlugin(pluginKey)
    const result = await services.installer.rollback(pluginKey)
    if (result.ok) {
      await pluginService.refresh()
    }
    return result
  })
}
