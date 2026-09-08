import { webVoiceSettingsOperations } from '../settings/web-voice-settings-operations'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostSessionDictationOperations } from './host-session-dictation-operations'

export function webHostSessionDictationOperations(
  client: MobileWebBridgeClient
): HostSessionDictationOperations {
  const settings = webVoiceSettingsOperations(client)
  return {
    loadSetup: () => settings.load(),
    async downloadModel(modelId) {
      await settings.download(modelId)
    },
    deleteModel: (modelId) => settings.delete(modelId),
    configure: (payload) => settings.configure(payload),
    subscribe: (onEvent, onError) => client.speech.subscribe(onEvent, onError),
    start: () => client.speech.start(),
    stop: () => client.speech.stop(),
    async cancel() {
      await client.speech.cancel()
    }
  }
}
