import { ipcMain } from 'electron'
import {
  clearSonioxSpeechApiKey,
  getSonioxSpeechApiKeyProtection,
  hasSonioxSpeechApiKey
} from '../speech/soniox-api-key-store'
import { saveVerifiedSonioxSpeechApiKey } from '../speech/soniox-key-verification'

export function registerSonioxSpeechKeyHandlers(): void {
  ipcMain.handle('speech:getSonioxApiKeyStatus', async () => ({
    configured: await hasSonioxSpeechApiKey(),
    protection: await getSonioxSpeechApiKeyProtection()
  }))

  ipcMain.handle('speech:saveSonioxApiKey', async (_event, apiKey: string) => {
    await saveVerifiedSonioxSpeechApiKey(apiKey)
    return { configured: true, protection: await getSonioxSpeechApiKeyProtection() }
  })

  ipcMain.handle('speech:clearSonioxApiKey', async () => {
    await clearSonioxSpeechApiKey()
    return { configured: false, protection: null }
  })
}
