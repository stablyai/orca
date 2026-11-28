import { ipcMain } from 'electron'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type { Store } from '../../persistence/loading-store/store'
import { getUserPluginsDir } from '../../plugins/discovery/plugin-discovery'
import {
  installPluginFromGit,
  installPluginFromLocalPath
} from '../../plugins/installation/plugin-install'
import { uninstallInstalledPlugin } from '../../plugins/installation/plugin-uninstall'
import { assertTeamAllowsUncatalogedPlugin } from '../../plugins/installation/plugin-team-install-policy'
import { readApprovedPluginNewFileTemplate } from '../../plugins/contributions/plugin-new-file-template'
import { readPluginPanelImage } from '../../plugins/panels/panel-lifetime/plugin-panel-image'
import { clearPluginFrameStorage } from '../../plugins/panels/guest-isolation/plugin-frame-guest-sessions'
import { isQualifiedPluginKey } from '../../../shared/plugins/frames/plugin-tab-key'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import { resolvePluginGitSource } from '../../plugins/installation/plugin-git-ref-resolution'
import { listPluginsForClients } from '../../plugins/discovery/plugin-client-list'
import type { PluginService } from '../../plugins/plugin-service'
import { rendererPanelOwner } from './plugin-frame-entry-ipc'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'

const readNewFileTemplateArgsSchema = lazyZodSchema(() =>
  z.object({
    pluginKey: z.string().min(1),
    newFileId: z.string().min(1)
  })
)

const installArgsSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
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
)

const resolveGitSourceArgsSchema = lazyZodSchema(() =>
  z.object({
    url: z.string().trim().min(1).refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH'),
    ref: z.string().trim().max(4096)
  })
)

const removeArgsSchema = lazyZodSchema(() =>
  z.object({
    pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
  })
)

export function parsePluginInstallArgs(args: unknown): z.infer<typeof installArgsSchema> {
  return installArgsSchema.parse(args)
}

export function registerPluginManagementHandlers(
  store: Store,
  pluginService: PluginService,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('plugins:readNewFileTemplate', async (_event, args: unknown) => {
    const parsed = readNewFileTemplateArgsSchema.parse(args)
    await pluginService.whenReady()
    return readApprovedPluginNewFileTemplate(pluginService, parsed.pluginKey, parsed.newFileId)
  })

  // Components panels' Image files: bytes from inside the plugin, never a URL the renderer loads.
  ipc.handle('plugins:panelImage', async (event, args: unknown) => {
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

  ipc.handle('plugins:resolveGitSource', async (_event, args: unknown) =>
    resolvePluginGitSource(resolveGitSourceArgsSchema.parse(args))
  )

  ipc.handle('plugins:install', async (_event, args: unknown) => {
    assertTeamAllowsUncatalogedPlugin()
    await pluginService.whenReady()
    const parsed = parsePluginInstallArgs(args)
    const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
    const hostVersion = pluginService.options.hostVersion
    const blockedPluginReason = (pluginKey: string): string | null => {
      const block = pluginService.options.getPluginKillListEntry?.(pluginKey)
      return block?.team ? null : (block?.reason ?? null)
    }
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

  ipc.handle('plugins:remove', async (_event, args: unknown) => {
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
}
