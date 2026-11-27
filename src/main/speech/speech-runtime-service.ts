import type { ModelManager } from './model-manager'
import type { SttService } from './stt-service'
import type { VoiceSettings } from '../../shared/speech/speech-types'

/** Hosts inject Chromium/Node download factories; missing services reject per call rather than appearing to transcribe. */

type SpeechSettingsStore = {
  getSettings(): {
    voice?: VoiceSettings
  }
}

export type SpeechServiceFactories = {
  createModelManager(customModelsDir: string | undefined): ModelManager
  /** `gpuEnabled` reads the user's Voice setting at each recognizer start. */
  createSttService(models: ModelManager, gpuEnabled: () => boolean): SttService
}

let factories: SpeechServiceFactories | null = null
let factoriesLoader: (() => Promise<SpeechServiceFactories>) | null = null
let factoriesPromise: Promise<void> | null = null
let modelManager: ModelManager | null = null
let sttService: SttService | null = null

export function setSpeechServiceFactories(next: SpeechServiceFactories | null): void {
  factories = next
  factoriesLoader = null
  factoriesPromise = null
  modelManager = null
  sttService = null
}

export function setSpeechServiceFactoriesLoader(
  loader: (() => Promise<SpeechServiceFactories>) | null
): void {
  factories = null
  factoriesLoader = loader
  factoriesPromise = null
  modelManager = null
  sttService = null
}

export function ensureSpeechServiceFactories(): Promise<void> {
  if (factories || !factoriesLoader) {
    return Promise.resolve()
  }
  if (!factoriesPromise) {
    const loader = factoriesLoader
    factoriesPromise = loader()
      .then((loaded) => {
        if (factoriesLoader === loader && !factories) {
          factories = loaded
        }
      })
      .catch((error: unknown) => {
        factoriesPromise = null
        throw error
      })
  }
  return factoriesPromise
}

function requireFactories(): SpeechServiceFactories {
  if (!factories) {
    throw new Error('speech_unavailable: this host has no speech services')
  }
  return factories
}

export function getSpeechModelManager(store: SpeechSettingsStore): ModelManager {
  if (!modelManager) {
    const settings = store.getSettings()
    const customDir = settings.voice?.modelsDir || undefined
    modelManager = requireFactories().createModelManager(customDir || undefined)
  }
  return modelManager
}

export function getSpeechSttService(store: SpeechSettingsStore): SttService {
  if (!sttService) {
    sttService = requireFactories().createSttService(
      getSpeechModelManager(store),
      () => store.getSettings().voice?.speechGpu !== 'off'
    )
  }
  return sttService
}

/** The service only if something already created it, so a host with voice off never builds one. */
export function findSpeechSttService(): SttService | null {
  return sttService
}
