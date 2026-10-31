import { pluginThemeSettingsAfterRemoval } from '../../shared/plugin-theme-settings'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PluginFrameEntry } from '../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginHostCallOutcome } from '../../shared/plugins/frames/plugin-protocol'
import { getUserPluginsDir, getPluginsDataDir } from '../plugins/plugin-discovery'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from '../plugins/installation/plugin-install'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import { readApprovedPluginNewFileTemplate } from '../plugins/plugin-new-file-template'
import type { PluginService } from '../plugins/plugin-service'
import { bindPluginPanelOwnerLifecycle } from '../plugins/panels/plugin-panel-owner-lifecycle'
import { isQualifiedPluginKey } from '../../shared/plugins/manifest/plugin-manifest'
import { pluginConsentRequestSchema } from '../../shared/plugins/approval/plugin-consent-request'
import { normalizePluginIdList } from '../../shared/plugins/approval/plugin-consent-state'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN,
  type PluginLockfile
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

const readPanelEntryArgsSchema = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1)
})

const readCustomEditorEntryArgsSchema = z.object({
  pluginKey: z.string().min(1),
  editorId: z.string().min(1)
})

const readNewFileTemplateArgsSchema = z.object({
  pluginKey: z.string().min(1),
  newFileId: z.string().min(1)
})

const invokeCommandArgsSchema = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
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
import { listPluginsForClients, readInstalledPluginManifest } from '../plugins/plugin-client-list'

export function canRemoveInstalledPlugin(
  pluginService: PluginService,
  pluginKey: string,
  lock?: PluginLockfile
): boolean {
  return (
    lock?.plugins[pluginKey]?.source.kind !== 'bundled' &&
    pluginService.getDiscovered().some((plugin) => plugin.pluginKey === pluginKey && !plugin.isDev)
  )
}

function rendererPanelOwner(webContentsId: number): string {
  return `renderer:${webContentsId}`
}

export function registerPluginHandlers(
  store: Store,
  pluginService: PluginService,
  runtime: OrcaRuntimeService | null,
  marketplaceServices?: PluginMarketplaceHandlerServices
): void {
  // A structural delegate binds the real runtime without importing Electron into the facade.
  if (runtime) {
    pluginService.setRuntimeDelegate(runtime)
  }

  store.onSettingsChanged((updates) => {
    if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
      // Main owns lifecycle refresh even when a caller crashes before its follow-up refresh.
      void pluginService.refresh().catch((error) => {
        console.warn('[plugins] failed to apply plugin settings change:', error)
      })
    }
  })

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

  // Sandboxed iframe srcdoc needs CSP-wrapped HTML contents across IPC.
  const openFrameEntry = async (
    sender: IpcMainInvokeEvent['sender'],
    open: (ownerKey: string, isCurrent: () => boolean) => Promise<PluginFrameEntry | null>
  ): Promise<PluginFrameEntry | null> => {
    const ownerKey = rendererPanelOwner(sender.id)
    const ownerLease = bindPluginPanelOwnerLifecycle(sender, () =>
      pluginService.panels.revokeOwner(ownerKey)
    )
    await pluginService.whenReady()
    // Why not revoke on a stale load: the owner key may already belong to a successor document.
    return open(ownerKey, ownerLease.isCurrent)
  }

  ipcMain.handle('plugins:readPanelEntry', (event, args: unknown) => {
    const parsed = readPanelEntryArgsSchema.parse(args)
    return openFrameEntry(event.sender, (ownerKey, isCurrent) =>
      pluginService.panels.open(ownerKey, parsed.pluginKey, parsed.panelId, isCurrent)
    )
  })

  ipcMain.handle('plugins:readCustomEditorEntry', (event, args: unknown) => {
    const parsed = readCustomEditorEntryArgsSchema.parse(args)
    return openFrameEntry(event.sender, (ownerKey, isCurrent) =>
      pluginService.panels.openCustomEditor(ownerKey, parsed.pluginKey, parsed.editorId, isCurrent)
    )
  })

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
      return pluginService.panels.execute(rendererPanelOwner(event.sender.id), args)
    }
  )

  ipcMain.handle('plugins:invokeCommand', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = invokeCommandArgsSchema.parse(args)
    return pluginService.invokeCommand(parsed.pluginKey, parsed.commandId, parsed.args)
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
    const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
    const lock = await readPluginLockfile(pluginsDir)
    if (!canRemoveInstalledPlugin(pluginService, parsed.pluginKey, lock)) {
      throw new Error(`cannot remove protected or non-installed plugin ${parsed.pluginKey}`)
    }
    await pluginService.removePlugin(parsed.pluginKey, () =>
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
        pluginKey: parsed.pluginKey
      })
    )
    const settings = store.getSettings()
    const consents = { ...settings.pluginConsents }
    delete consents[parsed.pluginKey]
    const disabledPlugins = normalizePluginIdList(settings.disabledPlugins).filter(
      (pluginKey) => pluginKey !== parsed.pluginKey
    )
    store.updateSettings(
      {
        pluginConsents: consents,
        disabledPlugins,
        ...pluginThemeSettingsAfterRemoval(settings, parsed.pluginKey)
      },
      // Why no origin: the uninstalling window must also drop the plugin's theme choices.
      { notifyListeners: true }
    )
    await pluginService.refresh()
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
