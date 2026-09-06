import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostSessionDictationOperations } from './host-session-dictation-operations'

export function webHostSessionDictationOperations(
  client: MobileWebBridgeClient
): HostSessionDictationOperations {
  return {
    loadSetup: () => client.speech.setup(),
    async downloadModel(modelId) {
      await client.speech.downloadModel(modelId)
    },
    deleteModel: (modelId) => client.speech.deleteModel(modelId),
    configure: (payload) => client.speech.configure(payload),
    subscribe: (onEvent, onError) => client.speech.subscribe(onEvent, onError),
    start: () => client.speech.start(),
    stop: () => client.speech.stop(),
    async cancel() {
      await client.speech.cancel()
    }
  }
}
