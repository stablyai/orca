import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { agentHookServer } from '../agent-hooks/server'
import { translateMain } from '../i18n/main-i18n'
import { connectDiscordIpc } from './discord-ipc-client'
import { getDiscordIpcSocketPaths } from './discord-ipc-socket-paths'
import { DiscordPresenceService } from './discord-presence-service'

// Why: Discord shows this application's name and `orca` art asset on the profile. Empty until a
// maintainer registers the application; until then every connect fails fast.
const ORCA_DISCORD_CLIENT_ID = ''

/** Starts Rich Presence for the desktop app and returns its teardown. */
export function installDiscordPresence(store: Store): () => void {
  const service = new DiscordPresenceService({
    translate: translateMain,
    connect: ({ onClosed }) =>
      connectDiscordIpc({
        clientId: process.env.ORCA_DISCORD_CLIENT_ID || ORCA_DISCORD_CLIENT_ID,
        socketPaths: getDiscordIpcSocketPaths(process.platform, process.env),
        pid: process.pid,
        onClosed
      })
  })

  ipcMain.handle('discordPresence:getStatus', () => service.getStatus())
  const unsubscribeStatus = service.subscribe((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('discordPresence:changed', status)
      }
    }
  })
  const unsubscribeSettings = store.onSettingsChanged((updates, settings) => {
    if ('discordPresenceEnabled' in updates) {
      service.setEnabled(settings.discordPresenceEnabled === true)
    }
  })
  const unsubscribeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) =>
    service.setStatuses(statuses)
  )
  const unsubscribeStatusFreshness = agentHookServer.subscribeStatusFreshness((status) =>
    service.observeStatusFreshness(status)
  )
  service.setEnabled(store.getSettings().discordPresenceEnabled === true)

  return () => {
    unsubscribeStatus()
    unsubscribeSettings()
    unsubscribeStatusChanges()
    unsubscribeStatusFreshness()
    ipcMain.removeHandler('discordPresence:getStatus')
    service.dispose()
  }
}
