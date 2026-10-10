import { ipcMain } from 'electron'
import {
  isCloudSpeechProviderId,
  type CloudSpeechKeyStatus,
  type CloudSpeechKeyTestResult,
  type CloudSpeechProviderId
} from '../../shared/cloud-speech-providers'
import {
  clearCloudSpeechApiKey,
  getAllCloudSpeechKeyStatuses,
  getCloudSpeechKeyStatus,
  hasCloudSpeechApiKey,
  readCloudSpeechApiKey,
  saveCloudSpeechApiKey
} from '../speech/cloud-speech-key-store'
import { saveCloudSpeechApiKeyIfLatest } from '../speech/cloud-speech-key-change-fence'
import { verifyCloudSpeechApiKey } from '../speech/cloud-speech-key-verification'

function requireProviderId(value: unknown): CloudSpeechProviderId {
  if (!isCloudSpeechProviderId(value)) {
    throw new Error('Unknown cloud speech provider')
  }
  return value
}

/** Desktop channels for every cloud provider's key; the key itself never travels back. */
export function registerCloudSpeechKeyHandlers(): void {
  ipcMain.handle('speech:getCloudKeyStatuses', (): CloudSpeechKeyStatus[] =>
    getAllCloudSpeechKeyStatuses()
  )

  ipcMain.handle(
    'speech:saveCloudKey',
    async (_event, rawProviderId: unknown, apiKey: unknown, verify: unknown) => {
      const providerId = requireProviderId(rawProviderId)
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        throw new Error('API key is required')
      }
      await saveCloudSpeechApiKeyIfLatest(
        providerId,
        async () => {
          if (verify !== true) {
            return
          }
          const result = await verifyCloudSpeechApiKey(providerId, apiKey)
          if (!result.ok) {
            throw new Error(result.message ?? 'The provider rejected this API key.')
          }
        },
        () => saveCloudSpeechApiKey(providerId, apiKey)
      )
      return getCloudSpeechKeyStatus(providerId)
    }
  )

  ipcMain.handle('speech:clearCloudKey', (_event, rawProviderId: unknown) => {
    const providerId = requireProviderId(rawProviderId)
    clearCloudSpeechApiKey(providerId)
    return getCloudSpeechKeyStatus(providerId)
  })

  ipcMain.handle(
    'speech:testCloudKey',
    async (_event, rawProviderId: unknown): Promise<CloudSpeechKeyTestResult> => {
      const providerId = requireProviderId(rawProviderId)
      if (!hasCloudSpeechApiKey(providerId)) {
        return { ok: false, message: 'No API key saved.' }
      }
      try {
        return await verifyCloudSpeechApiKey(providerId, readCloudSpeechApiKey(providerId))
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
