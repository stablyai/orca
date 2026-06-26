/**
 * IPC for the Add-Project "Devcontainer" source: lists running/known
 * devcontainers the renderer can offer as projects. Docker being unavailable
 * (not installed / daemon down) is not an error here — it just means there are
 * no devcontainers to offer, so the source stays empty rather than throwing.
 */
import { ipcMain } from 'electron'
import { listDevcontainers, type DevcontainerInfo } from '../devcontainer/discovery'

export function registerDevcontainerHandlers(): void {
  ipcMain.handle('devcontainer:list', async (): Promise<DevcontainerInfo[]> => {
    try {
      return await listDevcontainers(undefined, { all: true })
    } catch (error) {
      console.warn('[devcontainer] list failed (docker unavailable?):', error)
      return []
    }
  })
}
