import { ipcMain } from 'electron'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { Store } from '../../persistence/loading-store/store'
import type { PluginHostCallOutcome } from '../../../shared/plugins/frames/plugin-protocol'
import { getPluginsDataDir } from '../../plugins/discovery/plugin-discovery'
import { takeRequiredPluginFailures } from '../../plugins/catalog/required-plugin-failures'
import {
  applyPluginConsent,
  applyPluginEnablement
} from '../../plugins/activation/plugin-enablement'
import { handlePluginPanelStateRequest } from '../../plugins/panels/panel-lifetime/plugin-panel-state'
import type { PluginService } from '../../plugins/plugin-service'
import { registerPluginFrameEntryHandlers, rendererPanelOwner } from './plugin-frame-entry-ipc'
import { registerPluginPanelPushHandlers } from './plugin-panel-push-ipc'
import { registerPluginSettingsHandlers } from './plugin-settings-ipc'
import { registerPluginStatusBarHandlers } from './plugin-status-bar-ipc'
import { registerPluginEditorSaveHookHandler } from './plugin-editor-save-hook-ipc'
import { bindPluginFrameGuests } from '../../plugins/panels/guest-isolation/plugin-frame-guest-sessions'
import { isQualifiedPluginKey } from '../../../shared/plugins/frames/plugin-tab-key'
import { pluginConsentRequestSchema } from '../../../shared/plugins/approval/plugin-consent-request'
import type { PluginMarketplaceHandlerServices } from './plugin-marketplaces'
import { registerLazyPluginMarketplaceHandlers } from './lazy-plugin-marketplaces-ipc'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const PLUGIN_MANAGEMENT_IPC_CHANNELS = [
  'plugins:readNewFileTemplate',
  'plugins:panelImage',
  'plugins:resolveGitSource',
  'plugins:install',
  'plugins:remove'
] as const

export function parsePluginConsentArgs(args: unknown): z.infer<typeof pluginConsentRequestSchema> {
  return pluginConsentRequestSchema.parse(args)
}

const setEnabledArgsSchema = lazyZodSchema(() =>
  z.object({
    pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
    enabled: z.boolean()
  })
)

const invokeCommandArgsSchema = lazyZodSchema(() =>
  z.object({
    pluginKey: z.string().min(1),
    commandId: z.string().min(1),
    args: z.unknown().optional(),
    /** Run only if the worker can start it within this many ms (a replacement's fallback). */
    timeoutMs: z.number().int().positive().max(60_000).optional()
  })
)

const logsArgsSchema = lazyZodSchema(() => z.object({ pluginKey: z.string().min(1) }))

// Preserve import compatibility; runtime RPC uses the Electron-free client-list module.
import {
  listPluginsForClients,
  readInstalledPluginManifest
} from '../../plugins/discovery/plugin-client-list'

export function registerPluginHandlers(
  store: Store,
  pluginService: PluginService,
  marketplaceServices?: PluginMarketplaceHandlerServices
): void {
  // All handlers must await startup discovery to avoid returning a pre-discovery empty list.
  ipcMain.handle('plugins:list', async () => listPluginsForClients(pluginService))
  ipcMain.handle('plugins:takeRequiredPluginFailures', () => takeRequiredPluginFailures())
  ipcMain.handle('plugins:getInstalledManifest', async (_event, args: unknown) => {
    const { pluginKey } = logsArgsSchema.parse(args)
    return readInstalledPluginManifest(pluginService, pluginKey)
  })
  const handleContentPacks = (channel: string, read: (arg: unknown) => unknown): void => {
    ipcMain.handle(channel, async (_event, arg: unknown) => {
      await pluginService.whenReady()
      return read(arg)
    })
  }
  const { contentPacks } = pluginService
  handleContentPacks('plugins:listLanguagePacks', () => contentPacks.languagePacks.list())
  handleContentPacks('plugins:listThemes', () => contentPacks.themes.list())
  handleContentPacks('plugins:listTerminalThemes', () => contentPacks.terminalThemes.list())
  handleContentPacks('plugins:listIconThemes', () => contentPacks.iconThemes.list())
  handleContentPacks('plugins:loadIconTheme', (id) =>
    typeof id === 'string' ? contentPacks.iconThemes.load(id) : null
  )
  handleContentPacks('plugins:listSyntaxes', () => contentPacks.syntaxes.list())
  handleContentPacks('plugins:loadSyntax', (id) =>
    typeof id === 'string' ? contentPacks.syntaxes.load(id) : null
  )
  ipcMain.handle('plugins:consent', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = parsePluginConsentArgs(args)
    await applyPluginConsent({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      reviewedFingerprint: parsed.reviewedFingerprint,
      decision: parsed.decision
    })
    return listPluginsForClients(pluginService)
  })

  ipcMain.handle('plugins:setEnabled', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = setEnabledArgsSchema.parse(args)
    await applyPluginEnablement({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      enabled: parsed.enabled
    })
    return listPluginsForClients(pluginService)
  })

  bindPluginFrameGuests(pluginService)
  registerPluginFrameEntryHandlers(store, pluginService)
  registerPluginPanelPushHandlers(pluginService)
  registerPluginStatusBarHandlers(pluginService)
  registerPluginEditorSaveHookHandler()
  registerPluginSettingsHandlers(pluginService)

  registerLazyIpcHandleGroup(PLUGIN_MANAGEMENT_IPC_CHANNELS, async (ipc) => {
    const { registerPluginManagementHandlers } = await import('./plugin-management-ipc')
    registerPluginManagementHandlers(store, pluginService, ipc)
  })

  // Renderer forwards frame host calls; main enforces capabilities and surfaces.
  ipcMain.handle(
    'plugins:panelAction',
    async (event, args: unknown): Promise<PluginHostCallOutcome> => {
      await pluginService.whenReady()
      return pluginService.panels.execute(rendererPanelOwner(event.sender.id), args, {
        desktop: true,
        callerWebContentsId: event.sender.id
      })
    }
  )

  // Components panels' persisted atoms; desktop only, like the guests that write them.
  ipcMain.handle('plugins:panelState', async (event, args: unknown) => {
    await pluginService.whenReady()
    const owner = rendererPanelOwner(event.sender.id)
    return handlePluginPanelStateRequest(
      {
        pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
        resolveComponentsPanel: (token) => pluginService.panels.componentsPanelPlugin(owner, token)
      },
      args
    )
  })

  ipcMain.handle('plugins:invokeCommand', async (_event, args: unknown) => {
    // Why before whenReady: the caller's deadline started when it asked, not when plugins loaded.
    const askedAt = Date.now()
    await pluginService.whenReady()
    const parsed = invokeCommandArgsSchema.parse(args)
    const startBy = parsed.timeoutMs === undefined ? undefined : askedAt + parsed.timeoutMs
    return pluginService.invokeCommand(parsed.pluginKey, parsed.commandId, parsed.args, startBy)
  })

  ipcMain.handle('plugins:getLogs', async (_event, args: unknown) => {
    const parsed = logsArgsSchema.parse(args)
    return pluginService.getLogs(parsed.pluginKey)
  })

  ipcMain.handle('plugins:refresh', async () => {
    await pluginService.refresh()
    return listPluginsForClients(pluginService)
  })
  if (marketplaceServices) {
    registerLazyPluginMarketplaceHandlers(
      pluginService,
      marketplaceServices,
      () => store.getSettings(),
      (pluginKey, reviewedFingerprint) =>
        applyPluginConsent({
          store,
          pluginService,
          pluginKey,
          reviewedFingerprint,
          decision: 'approve'
        })
    )
  }
}
