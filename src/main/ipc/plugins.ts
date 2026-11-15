import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence/loading-store/store'
import type { PluginHostCallOutcome } from '../../shared/plugins/frames/plugin-protocol'
import { getUserPluginsDir, getPluginsDataDir } from '../plugins/discovery/plugin-discovery'
import {
  installPluginFromGit,
  installPluginFromLocalPath
} from '../plugins/installation/plugin-install'
import { uninstallInstalledPlugin } from '../plugins/installation/plugin-uninstall'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/activation/plugin-enablement'
import { readApprovedPluginNewFileTemplate } from '../plugins/contributions/plugin-new-file-template'
import { handlePluginPanelStateRequest } from '../plugins/panels/panel-lifetime/plugin-panel-state'
import type { PluginService } from '../plugins/plugin-service'
import { registerPluginFrameEntryHandlers, rendererPanelOwner } from './plugin-frame-entry-ipc'
import { registerPluginPanelPushHandlers } from './plugin-panel-push-ipc'
import { registerPluginSettingsHandlers } from './plugin-settings-ipc'
import { registerPluginStatusBarHandlers } from './plugin-status-bar-ipc'
import { registerPluginEditorSaveHookHandler } from './plugin-editor-save-hook-ipc'
import { readPluginPanelImage } from '../plugins/panels/panel-lifetime/plugin-panel-image'
import {
  bindPluginFrameGuests,
  clearPluginFrameStorage
} from '../plugins/panels/guest-isolation/plugin-frame-guest-sessions'
import { isQualifiedPluginKey } from '../../shared/plugins/manifest/plugin-manifest'
import { pluginConsentRequestSchema } from '../../shared/plugins/approval/plugin-consent-request'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN
} from '../../shared/plugins/installation/plugin-install-lockfile'
import { resolvePluginGitSource } from '../plugins/installation/plugin-git-ref-resolution'
import {
  registerPluginMarketplaceHandlers,
  type PluginMarketplaceHandlerServices
} from './plugin-marketplaces'

export function parsePluginConsentArgs(args: unknown): z.infer<typeof pluginConsentRequestSchema> {
  return pluginConsentRequestSchema.parse(args)
}

const setEnabledArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean()
})

const readNewFileTemplateArgsSchema = z.object({
  pluginKey: z.string().min(1),
  newFileId: z.string().min(1)
})

const invokeCommandArgsSchema = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional(),
  /** Run only if the worker can start it within this many ms (a replacement's fallback). */
  timeoutMs: z.number().int().positive().max(60_000).optional()
})

const installArgsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-path'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('git'),
    url: z.string().trim().min(1).refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
    // Why: installs must stay reproducible even when callers bypass renderer validation.
    ref: z.string().trim().min(1),
    /** The commit the dialog showed; install fails if the ref moved since. */
    expectedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN).optional()
  })
])

const resolveGitSourceArgsSchema = z.object({
  url: z.string().trim().min(1).refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
  ref: z.string().trim().max(4096)
})

export function parsePluginInstallArgs(args: unknown): z.infer<typeof installArgsSchema> {
  return installArgsSchema.parse(args)
}

const removeArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
const logsArgsSchema = z.object({ pluginKey: z.string().min(1) })

// Preserve import compatibility; runtime RPC uses the Electron-free client-list module.
import {
  listPluginsForClients,
  readInstalledPluginManifest
} from '../plugins/discovery/plugin-client-list'

export function registerPluginHandlers(
  store: Store,
  pluginService: PluginService,
  marketplaceServices?: PluginMarketplaceHandlerServices
): void {
  // All handlers must await startup discovery to avoid returning a pre-discovery empty list.
  ipcMain.handle('plugins:list', async () => listPluginsForClients(pluginService))
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

  ipcMain.handle('plugins:readNewFileTemplate', async (_event, args: unknown) => {
    const parsed = readNewFileTemplateArgsSchema.parse(args)
    await pluginService.whenReady()
    return readApprovedPluginNewFileTemplate(pluginService, parsed.pluginKey, parsed.newFileId)
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

  // Components panels' Image files: bytes from inside the plugin, never a URL the renderer loads.
  ipcMain.handle('plugins:panelImage', async (event, args: unknown) => {
    await pluginService.whenReady()
    const owner = rendererPanelOwner(event.sender.id)
    return readPluginPanelImage(
      {
        resolveComponentsPanelRoot: (token) =>
          pluginService.panels.componentsPanelRoot(owner, token)
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

  ipcMain.handle('plugins:resolveGitSource', async (_event, args: unknown) =>
    resolvePluginGitSource(resolveGitSourceArgsSchema.parse(args))
  )

  ipcMain.handle('plugins:install', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = parsePluginInstallArgs(args)
    const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
    const hostVersion = pluginService.options.hostVersion
    const blockedPluginReason = (pluginKey: string): string | null =>
      pluginService.options.getPluginKillListEntry?.(pluginKey)?.reason ?? null
    const result =
      parsed.kind === 'local-path'
        ? await installPluginFromLocalPath({
            pluginsDir,
            sourcePath: parsed.path,
            hostVersion,
            blockedPluginReason
          })
        : await installPluginFromGit({
            pluginsDir,
            url: parsed.url,
            ref: parsed.ref,
            ...(parsed.expectedCommit ? { expectedCommit: parsed.expectedCommit } : {}),
            hostVersion,
            blockedPluginReason
          })
    if (result.ok) {
      await pluginService.refresh()
    }
    return result
  })

  ipcMain.handle('plugins:remove', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = removeArgsSchema.parse(args)
    const removed = await uninstallInstalledPlugin({
      pluginService,
      store,
      pluginKey: parsed.pluginKey,
      afterRemove: clearPluginFrameStorage
    })
    if (!removed) {
      throw new Error(`cannot remove protected or non-installed plugin ${parsed.pluginKey}`)
    }
    return listPluginsForClients(pluginService)
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
    registerPluginMarketplaceHandlers(
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
