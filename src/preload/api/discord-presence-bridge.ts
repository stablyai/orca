import { ipcRenderer } from 'electron'
import type { DiscordPresenceStatus } from '../../shared/discord-presence-status'
import type { PreloadApi } from '../api-types'

export type DiscordPresenceApi = {
  getStatus: () => Promise<DiscordPresenceStatus>
  onChanged: (callback: (status: DiscordPresenceStatus) => void) => () => void
}

export const discordPresenceApi = {
  getStatus: (): Promise<DiscordPresenceStatus> => ipcRenderer.invoke('discordPresence:getStatus'),
  onChanged: (callback: (status: DiscordPresenceStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: DiscordPresenceStatus): void =>
      callback(status)
    ipcRenderer.on('discordPresence:changed', listener)
    return () => ipcRenderer.removeListener('discordPresence:changed', listener)
  }
} satisfies PreloadApi['discordPresence']
