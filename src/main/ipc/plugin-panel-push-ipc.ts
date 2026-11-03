import { ipcMain } from 'electron'
import { z } from 'zod'
import { panelSessionTokenSchema } from '../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginService } from '../plugins/plugin-service'
import { rendererPanelOwner } from './plugin-frame-entry-ipc'

const panelPushArgsSchema = z.object({ sessionToken: panelSessionTokenSchema }).strict()

/** main → renderer: one open panel's worker posts, events and data changes. */
export const PLUGIN_PANEL_PUSH_CHANNEL = 'plugins:panelPush'

/**
 * Desktop push channel per open panel session. It closes by itself when the session ends (the
 * window navigates or reloads, the plugin goes away); the renderer closes it when its last frame
 * for that session unmounts.
 */
export function registerPluginPanelPushHandlers(pluginService: PluginService): void {
  const stops = new Map<string, () => void>()
  ipcMain.handle('plugins:openPanelPush', async (event, args: unknown): Promise<boolean> => {
    await pluginService.whenReady()
    const parsed = panelPushArgsSchema.safeParse(args)
    const { sender } = event
    const session = parsed.success
      ? pluginService.panels.sessionCaller(rendererPanelOwner(sender.id), parsed.data.sessionToken)
      : null
    if (!parsed.success || !session) {
      return false
    }
    const { sessionToken } = parsed.data
    const key = `${sender.id}\0${sessionToken}`
    if (!stops.has(key)) {
      sender.once('destroyed', () => stops.delete(key))
    }
    stops.get(key)?.()
    stops.set(
      key,
      pluginService.panelBridge.open(session.caller, session.pluginKey, (push) => {
        if (!sender.isDestroyed()) {
          sender.send(PLUGIN_PANEL_PUSH_CHANNEL, { sessionToken, push })
        }
      })
    )
    return true
  })
  ipcMain.handle('plugins:closePanelPush', (event, args: unknown): void => {
    const parsed = panelPushArgsSchema.safeParse(args)
    if (parsed.success) {
      const key = `${event.sender.id}\0${parsed.data.sessionToken}`
      stops.get(key)?.()
      stops.delete(key)
    }
  })
}
