import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'
import type { VoiceSettingsOperations } from './voice-settings-operations'

export function webVoiceSettingsOperations(client: MobileWebBridgeClient): VoiceSettingsOperations {
  const request = (method: string, params: Record<string, unknown>) =>
    client.host.request({ method, params })
  return {
    load: async () => (await request('speech.models.list', {})) as MobileSpeechSetup,
    configure: async (params) =>
      (await request('speech.dictation.setup', params)) as MobileSpeechSetup,
    download: async (modelId) => {
      await request('speech.models.download', { modelId })
    },
    delete: async (modelId) =>
      (await request('speech.models.delete', { modelId })) as MobileSpeechSetup
  }
}
