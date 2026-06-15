import { ipcMain } from 'electron'
import { clearZaiApiKey, hasZaiApiKey, saveZaiApiKey } from '../zai-api-key-store'

export function registerZaiApiKeyHandlers(): void {
  ipcMain.handle('zaiApiKey:getStatus', async () => ({ configured: hasZaiApiKey() }))
  ipcMain.handle('zaiApiKey:save', async (_event, apiKey: string) => {
    saveZaiApiKey(apiKey)
    return { configured: true }
  })
  ipcMain.handle('zaiApiKey:clear', async () => {
    clearZaiApiKey()
    return { configured: false }
  })
}
