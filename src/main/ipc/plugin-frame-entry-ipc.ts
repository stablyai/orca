import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { PluginFrameEntry } from '../../shared/plugins/frames/plugin-frame-bridge'
import type { Store } from '../persistence/loading-store/store'
import type { PluginService } from '../plugins/plugin-service'
import { bindPluginPanelOwnerLifecycle } from '../plugins/panels/plugin-panel-owner-lifecycle'
import { preparePluginFrameGuest } from '../plugins/panels/plugin-frame-guest-sessions'
import { isPluginFrameIsolationEnabled } from '../plugins/panels/plugin-frame-isolation'
import {
  notePluginFrameTheme,
  pluginFrameThemeSchema
} from '../plugins/panels/plugin-frame-theme-snapshot'

const readPanelEntryArgsSchema = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1),
  theme: pluginFrameThemeSchema.optional()
})

const readCustomEditorEntryArgsSchema = z.object({
  pluginKey: z.string().min(1),
  editorId: z.string().min(1),
  theme: pluginFrameThemeSchema.optional()
})

export function rendererPanelOwner(webContentsId: number): string {
  return `renderer:${webContentsId}`
}

type FrameRequest = { pluginKey: string; surface: 'panel' | 'editor'; id: string }

/** Desktop frame entries: an isolated guest, or (kill switch off) the srcdoc iframe document. */
export function registerPluginFrameEntryHandlers(
  store: Pick<Store, 'getSettings'>,
  pluginService: PluginService
): void {
  const openFrameEntry = async (
    sender: IpcMainInvokeEvent['sender'],
    frame: FrameRequest
  ): Promise<PluginFrameEntry | null> => {
    const ownerKey = rendererPanelOwner(sender.id)
    const ownerLease = bindPluginPanelOwnerLifecycle(sender, () =>
      pluginService.panels.revokeOwner(ownerKey)
    )
    await pluginService.whenReady()
    const isolated = isPluginFrameIsolationEnabled(store.getSettings())
    // Why no shell for guests: the guest loads (and main verifies) its own document.
    const options = { shell: !isolated }
    const { pluginKey, id } = frame
    const isCurrent = ownerLease.isCurrent
    // Why not revoke on a stale load: the owner key may already belong to a successor document.
    const entry =
      frame.surface === 'panel'
        ? await pluginService.panels.open(ownerKey, pluginKey, id, isCurrent, options)
        : await pluginService.panels.openCustomEditor(ownerKey, pluginKey, id, isCurrent, options)
    if (!entry || !isolated) {
      return entry
    }
    const guest = await preparePluginFrameGuest(pluginKey, frame.surface, id)
    if (!guest) {
      // Fail closed: with isolation on, the srcdoc iframe is never a fallback for a setup failure.
      pluginService.panels.revokeSession(ownerKey, entry.sessionToken)
      return null
    }
    return { ...entry, guest }
  }

  ipcMain.handle('plugins:readPanelEntry', (event, args: unknown) => {
    const parsed = readPanelEntryArgsSchema.parse(args)
    notePluginFrameTheme(parsed.theme)
    return openFrameEntry(event.sender, {
      pluginKey: parsed.pluginKey,
      surface: 'panel',
      id: parsed.panelId
    })
  })

  ipcMain.handle('plugins:readCustomEditorEntry', (event, args: unknown) => {
    const parsed = readCustomEditorEntryArgsSchema.parse(args)
    notePluginFrameTheme(parsed.theme)
    return openFrameEntry(event.sender, {
      pluginKey: parsed.pluginKey,
      surface: 'editor',
      id: parsed.editorId
    })
  })
}
