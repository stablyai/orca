import type { RuntimeStore } from '../construction/runtime-store-contract'
import type { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import type { RuntimeMobileDictationController } from './runtime-mobile-dictation-controller'
import { ensureSpeechServiceFactories } from '../../speech/speech-runtime-service'

export type LazyMobileSpeechOwners = {
  loadMobileSpeech(): Promise<RuntimeMobileSpeechCatalog>
  loadMobileDictation(): Promise<RuntimeMobileDictationController>
  getLoadedMobileDictation(): RuntimeMobileDictationController | null
}

export function createLazyMobileSpeechOwners(
  getStore: () => RuntimeStore | null
): LazyMobileSpeechOwners {
  let speechInstance: RuntimeMobileSpeechCatalog | null = null
  let speechPromise: Promise<RuntimeMobileSpeechCatalog> | null = null
  let dictationInstance: RuntimeMobileDictationController | null = null
  let dictationPromise: Promise<RuntimeMobileDictationController> | null = null

  return {
    loadMobileSpeech(): Promise<RuntimeMobileSpeechCatalog> {
      if (speechInstance) {
        return Promise.resolve(speechInstance)
      }
      if (!speechPromise) {
        speechPromise = Promise.all([
          ensureSpeechServiceFactories(),
          import('./runtime-mobile-speech-catalog')
        ])
          .then(([, { RuntimeMobileSpeechCatalog }]) => {
            speechInstance = new RuntimeMobileSpeechCatalog(getStore)
            return speechInstance
          })
          .catch((error: unknown) => {
            speechPromise = null
            throw error
          })
      }
      return speechPromise
    },
    loadMobileDictation(): Promise<RuntimeMobileDictationController> {
      if (dictationInstance) {
        return Promise.resolve(dictationInstance)
      }
      if (!dictationPromise) {
        dictationPromise = Promise.all([
          ensureSpeechServiceFactories(),
          import('./runtime-mobile-dictation-controller')
        ])
          .then(([, { RuntimeMobileDictationController }]) => {
            dictationInstance = new RuntimeMobileDictationController(getStore)
            return dictationInstance
          })
          .catch((error: unknown) => {
            dictationPromise = null
            throw error
          })
      }
      return dictationPromise
    },
    getLoadedMobileDictation(): RuntimeMobileDictationController | null {
      return dictationInstance
    }
  }
}
