import { ipcMain } from 'electron'
import { getMediaPlaybackStatus } from '../media-playback/macos-media-playback-status'

export function registerMediaPlaybackHandlers(): void {
  ipcMain.handle('mediaPlayback:getStatus', getMediaPlaybackStatus)
}
