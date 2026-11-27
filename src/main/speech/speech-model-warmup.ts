import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { voiceModelUnloadDelayMs } from '../../shared/speech/models/voice-model-unload'
import {
  ensureSpeechServiceFactories,
  findSpeechSttService,
  getSpeechSttService
} from './speech-runtime-service'

type SpeechWarmupStore = {
  getSettings(): Pick<GlobalSettings, 'voice'>
  onSettingsChanged?(listener: (updates: Partial<GlobalSettings>) => void): unknown
}

/**
 * Keeps this host's selected on-device model loaded while voice is on, so the first dictation
 * does not wait for it. Returns a call that re-warms it when the user is likely to dictate.
 */
export function startSpeechModelWarmup(store: SpeechWarmupStore): () => void {
  let speechGpu = store.getSettings().voice?.speechGpu
  // A settings change retries a model that failed to load; a window focus does not.
  const sync = (retryFailed: boolean): void => {
    const voice = store.getSettings().voice
    if (!voice?.enabled || !voice.sttModel) {
      void findSpeechSttService()?.unloadIdleModel()
      return
    }
    const runPrewarm = (): void => {
      try {
        const latestVoice = store.getSettings().voice
        if (!latestVoice?.enabled || !latestVoice.sttModel) {
          void findSpeechSttService()?.unloadIdleModel()
          return
        }
        const stt = getSpeechSttService(store)
        stt.setIdleUnloadDelay(voiceModelUnloadDelayMs(latestVoice))
        const prewarm = (): void => {
          const current = store.getSettings().voice
          if (current?.enabled && current.sttModel) {
            void stt.prewarm(current.sttModel, current.dictationLanguage, retryFailed)
          }
        }
        // A loaded recognizer keeps the GPU choice it started with; reload it once no dictation uses it.
        if (latestVoice.speechGpu !== speechGpu) {
          speechGpu = latestVoice.speechGpu
          void stt.unloadModelWhenIdle().then(prewarm)
        } else {
          prewarm()
        }
      } catch (error) {
        // Runs inside settings writes; an unusable models folder must not fail the write.
        console.warn('[speech] Could not pre-warm the speech model:', error)
      }
    }
    void ensureSpeechServiceFactories().then(runPrewarm, (error: unknown) => {
      console.warn('[speech] Could not pre-warm the speech model:', error)
    })
  }
  store.onSettingsChanged?.((updates) => {
    if ('voice' in updates) {
      sync(true)
    }
  })
  sync(true)
  return () => sync(false)
}
