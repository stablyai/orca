import { ipcMain } from 'electron'
import { getCloudApiAvailability } from './cloud-api-service'

export const CLOUD_API_CHANNELS = ['cloudApi:availability'] as const

export function registerCloudApiHandlers(): void {
  for (const channel of CLOUD_API_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('cloudApi:availability', () => getCloudApiAvailability())
}
