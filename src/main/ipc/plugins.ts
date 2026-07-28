import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import { getUserPluginsDir, getPluginsDataDir } from '../plugins/plugin-discovery'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from '../plugins/plugin-install'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import { buildPluginList, type PluginListEntry } from '../plugins/plugin-list-projection'
import type { PluginService } from '../plugins/plugin-service'
import { bindPluginPanelOwnerLifecycle } from '../plugins/plugin-panel-owner-lifecycle'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import { pluginConsentRequestSchema } from '../../shared/plugins/plugin-consent-request'
import { normalizePluginIdList } from '../../shared/plugins/plugin-consent-state'
import {
  isAllowedPluginGitUrl,
  type PluginLockfile
} from '../../shared/plugins/plugin-install-lockfile'
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
    ref: z.string().trim().min(1)
  })
])

export function parsePluginInstallArgs(args: unknown): z.infer<typeof installArgsSchema> {
  return installArgsSchema.parse(args)
}

const removeArgsSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})
const logsArgsSchema = z.object({ pluginKey: z.string().min(1) })

export async function listPluginsForClients(
  pluginService: PluginService
): Promise<PluginListEntry[]> {
  await pluginService.whenReady()
  const lock = await readPluginLockfile(getUserPluginsDir(pluginService.options.userDataPath))
  return buildPluginList(pluginService, lock)
}

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
  // The runtime IS the delegate: the structural PluginRuntimeDelegate type
  // keeps the facade electron-free while main binds the real service.
  if (runtime) {
    pluginService.setRuntimeDelegate(runtime)
  }

  store.onSettingsChanged((updates) => {
    if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
      // Main owns plugin lifecycle. Renderer follow-up refreshes are UX only;
      // a crashed or remote caller must not leave old workers authoritative.
      void pluginService.refresh().catch((error) => {
        console.warn('[plugins] failed to apply plugin settings change:', error)
      })
    }
  })

  // Why: startup discovery is fire-and-forget; every handler awaits it so an
  // early renderer fetch can't observe the empty pre-discovery list.
  ipcMain.handle('plugins:list', async () => listPluginsForClients(pluginService))
  ipcMain.handle('plugins:listThemes', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.themes.list()
  })
  ipcMain.handle('plugins:listLanguagePacks', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.languagePacks.list()
  })
  ipcMain.handle('plugins:listIconThemes', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.iconThemes.list()
  })
  ipcMain.handle('plugins:loadIconTheme', async (_event, id: unknown) => {
    await pluginService.whenReady()
    return pluginService.contentPacks.iconThemes.load(
      z.string().startsWith('plugin:').max(256).parse(id)
    )
  })
  ipcMain.handle('plugins:listTerminalThemes', async () => {
    await pluginService.whenReady()
    return pluginService.contentPacks.terminalThemes.list()
  })
  ipcMain.handle('plugins:consent', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = parsePluginConsentArgs(args)
    await applyPluginConsent({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      reviewedFingerprint: parsed.reviewedFingerprint,
      decision: parsed.decision,
      originWebContentsId: event.sender.id
    })
    return listPluginsForClients(pluginService)
  })

  ipcMain.handle('plugins:setEnabled', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = setEnabledArgsSchema.parse(args)
    await applyPluginEnablement({
      store,
      pluginService,
      pluginKey: parsed.pluginKey,
      enabled: parsed.enabled,
      originWebContentsId: event.sender.id
    })
    return listPluginsForClients(pluginService)
  })

  // Why: the renderer renders panel HTML via a sandboxed iframe srcdoc, so it
  // needs (CSP-wrapped) file contents — never a file:// path — across IPC.
  ipcMain.handle(
    'plugins:readPanelEntry',
    async (event, args: unknown): Promise<PluginPanelEntry | null> => {
      const ownerKey = rendererPanelOwner(event.sender.id)
      const ownerLease = bindPluginPanelOwnerLifecycle(event.sender, () =>
        pluginService.panels.revokeOwner(ownerKey)
      )
      await pluginService.whenReady()
      const parsed = readPanelEntryArgsSchema.parse(args)
      const entry = await pluginService.panels.open(ownerKey, parsed.pluginKey, parsed.panelId)
      if (!ownerLease.isCurrent()) {
        pluginService.panels.revokeOwner(ownerKey)
        return null
      }
      return entry
    }
  )

  // Panel-originated actions relayed by the renderer's postMessage bridge
  // host. Capability enforcement happens in main, never in the renderer.
  ipcMain.handle(
    'plugins:panelAction',
    async (event, args: unknown): Promise<PluginPanelActionOutcome> => {
      await pluginService.whenReady()
      return pluginService.panels.execute(rendererPanelOwner(event.sender.id), args)
    }
  )

  ipcMain.handle('plugins:invokeCommand', async (_event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = invokeCommandArgsSchema.parse(args)
    return pluginService.invokeCommand(parsed.pluginKey, parsed.commandId, parsed.args)
  })

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
            hostVersion,
            blockedPluginReason
          })
    if (result.ok) {
      await pluginService.refresh()
    }
    return result
  })

  ipcMain.handle('plugins:remove', async (event, args: unknown) => {
    await pluginService.whenReady()
    const parsed = removeArgsSchema.parse(args)
    const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
    const lock = await readPluginLockfile(pluginsDir)
    if (!canRemoveInstalledPlugin(pluginService, parsed.pluginKey, lock)) {
      throw new Error(`cannot remove protected or non-installed plugin ${parsed.pluginKey}`)
    }
    await pluginService.deactivatePlugin(parsed.pluginKey)
    await removeInstalledPlugin({
      pluginsDir,
      pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
      pluginKey: parsed.pluginKey
    })
    // Drop the stale consent so a later reinstall re-prompts from scratch.
    const settings = store.getSettings()
    const consents = { ...settings.pluginConsents }
    delete consents[parsed.pluginKey]
    const disabledPlugins = normalizePluginIdList(settings.disabledPlugins).filter(
      (pluginKey) => pluginKey !== parsed.pluginKey
    )
    store.updateSettings(
      { pluginConsents: consents, disabledPlugins },
      { notifyListeners: true, originWebContentsId: event.sender.id }
    )
    await pluginService.refresh()
    return listPluginsForClients(pluginService)
  })

  ipcMain.handle('plugins:getLogs', async (_event, args: unknown) => {
    const parsed = logsArgsSchema.parse(args)
    return pluginService.getLogs(parsed.pluginKey)
  })

  // Re-discover after settings edits (feature flag, dev paths) — the
  // renderer calls this right after updating those settings.
  ipcMain.handle('plugins:refresh', async () => {
    await pluginService.refresh()
    return listPluginsForClients(pluginService)
  })
  if (marketplaceServices) {
    registerPluginMarketplaceHandlers(pluginService, marketplaceServices)
  }
}
