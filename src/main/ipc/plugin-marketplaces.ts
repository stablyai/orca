import {
  installCatalogReleaseWithApproval,
  readPreviewAccessGrowth
} from '../plugins/catalog/plugin-update-approval'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { PLUGIN_COMMIT_PATTERN } from '../../shared/plugins/installation/plugin-install-lockfile'
import { isQualifiedPluginKey } from '../../shared/plugins/manifest/plugin-manifest'
import { pluginMarketplaceGitSourceSchema } from '../../shared/plugins/catalog/plugin-marketplace'
import type { PluginMarketplaceInstaller } from '../plugins/catalog/plugin-marketplace-installer'
import type { PluginMarketplaceService } from '../plugins/catalog/plugin-marketplace-service'
import { PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN } from '../plugins/catalog/plugin-marketplace-store'
import type { PluginService } from '../plugins/plugin-service'
import type { PluginAutoUpdater } from '../plugins/catalog/plugin-auto-updater'
import type { PluginAutoUpdateState } from '../../shared/plugins/catalog/plugin-update-policy'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { pluginFileTypeSchema } from '../../shared/plugins/contributions/plugin-file-type'
import { findPluginFileTypeSuggestion } from '../plugins/catalog/plugin-file-type-suggestion'

export type PluginMarketplaceHandlerServices = {
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
  autoUpdater?: Pick<PluginAutoUpdater, 'getState'>
}

/** The consent write path (applyPluginConsent), bound to the store by the caller. */
export type PluginApproveConsent = (
  pluginKey: string,
  reviewedFingerprint: string,
  originWebContentsId: number
) => Promise<void>

const sourceIdSchema = z.string().regex(PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN)
const removeMarketplaceSchema = z.strictObject({ sourceId: sourceIdSchema })
const refreshMarketplaceSchema = z.strictObject({ sourceId: sourceIdSchema.optional() })
const marketplacePluginSchema = z.strictObject({
  marketplaceSourceId: sourceIdSchema,
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
const installMarketplacePluginSchema = marketplacePluginSchema.extend({
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  /** Ask main to approve in the same step if the installed plugin is content only. */
  enableIfData: z.literal(true).optional(),
  /** The preview's consentFingerprint: one-click approves only these exact bytes. */
  expectedFingerprint: z.string().min(1).max(256).optional(),
  /** The page was opened from an `orca://plugins/...` link; only labels install telemetry. */
  fromInstallLink: z.literal(true).optional()
})
const installedPluginSchema = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export function registerPluginMarketplaceHandlers(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices,
  getSettings: () => GlobalSettings,
  approveConsent: PluginApproveConsent
): void {
  // Why cached only: this runs on every file open, which must never wait on a catalog fetch.
  ipcMain.handle(
    'plugins:suggestForFileType',
    async (_event, fileType: unknown, purpose: unknown) => {
      const parsed = pluginFileTypeSchema.safeParse(fileType)
      if (!parsed.success) {
        return null
      }
      return findPluginFileTypeSuggestion({
        fileType: parsed.data,
        purpose: purpose === 'editor' ? 'editor' : 'open',
        settings: getSettings(),
        listings: await services.marketplace.listCachedPlugins(),
        installed: pluginService.getDiscovered()
      })
    }
  )
  // Startup defers the official seed; a marketplace view must not wait for that timer.
  const ensureOfficialSeed = (): void => {
    if (getSettings().pluginSystemEnabled === true) {
      void services.marketplace.seedOfficialSource().catch(() => undefined)
    }
  }
  ipcMain.handle('plugins:listMarketplaces', () => {
    ensureOfficialSeed()
    return services.marketplace.listSources()
  })
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
  ipcMain.handle('plugins:listMarketplacePlugins', () => {
    ensureOfficialSeed()
    return services.marketplace.listPlugins()
  })
  ipcMain.handle('plugins:previewMarketplacePlugin', async (_event, args: unknown) => {
    const parsed = marketplacePluginSchema.parse(args)
    return services.installer.preview(parsed.marketplaceSourceId, parsed.pluginKey)
  })
  ipcMain.handle('plugins:installMarketplacePlugin', async (event, args: unknown) => {
    const { enableIfData, expectedFingerprint, fromInstallLink, ...identity } =
      installMarketplacePluginSchema.parse(args)
    return installCatalogReleaseWithApproval({
      pluginKey: identity.pluginKey,
      pluginService,
      install: () =>
        services.installer.install(identity, {
          trigger: fromInstallLink ? 'deep_link' : 'catalog'
        }),
      approve: (pluginKey, reviewedFingerprint) =>
        approveConsent(pluginKey, reviewedFingerprint, event.sender.id),
      ...(enableIfData ? { enableIfData: { expectedFingerprint } } : {})
    })
  })
  ipcMain.handle('plugins:previewMarketplaceUpdate', async (_event, args: unknown) => {
    const { pluginKey } = installedPluginSchema.parse(args)
    const preview = await services.installer.previewInstalledUpdate(pluginKey)
    const installed = pluginService.findValidPlugin(pluginKey)
    if (!installed) {
      return preview
    }
    return { ...preview, accessGrowth: await readPreviewAccessGrowth(installed, preview) }
  })
  ipcMain.handle(
    'plugins:getAutoUpdateState',
    (): PluginAutoUpdateState =>
      services.autoUpdater?.getState() ?? { updated: {}, needsReview: {} }
  )
  ipcMain.handle('plugins:getRollbackVersion', (_event, args: unknown) => {
    const { pluginKey } = installedPluginSchema.parse(args)
    return services.installer.rollbackVersion(pluginKey)
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
