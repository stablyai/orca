import { engineDictationLanguage } from '../../shared/dictation-language'
import { getCatalogModel, isLocalSpeechModel } from './model-catalog'
import { spawnSttEngine } from './stt-session-start'
import {
  sameSttRecognizerConfig,
  sttEngineUsers,
  type SttRecognizerConfig,
  type SttSessionState
} from './stt-session-state'
import { scheduleSttIdleTeardown, teardownSttEngine } from './stt-session-stop'
import { hasLocalSpeechRecognizer } from './stt-worker-paths'

/**
 * Loads a downloaded local model before the first dictation, so the shortcut starts listening at once.
 * A model that failed to load is skipped until retryFailed (a settings change) or a dictation loads it.
 */
export async function prewarmSttModel(
  state: SttSessionState,
  modelId: string,
  language: string | undefined,
  retryFailed: boolean
): Promise<void> {
  const generation = ++state.prewarmGeneration
  const superseded = (): boolean => generation !== state.prewarmGeneration
  if (retryFailed) {
    state.prewarmFailedModelId = null
  }
  // "Immediately" means no recognizer stays loaded between dictations.
  if (state.idleUnloadMs === 0) {
    return
  }
  const manifest = getCatalogModel(modelId)
  const config: SttRecognizerConfig | null =
    manifest && isLocalSpeechModel(manifest)
      ? { modelId, language: engineDictationLanguage(manifest, language) }
      : null
  if (config && state.engine && sameSttRecognizerConfig(state.engine, config)) {
    return
  }
  const ready =
    manifest !== undefined &&
    config !== null &&
    hasLocalSpeechRecognizer() &&
    (await state.modelManager.getModelState(modelId)).status === 'ready'
  for (;;) {
    // Never disturb a dictation; whatever it loaded is what the user is using.
    if (superseded() || state.sessions.size > 0) {
      return
    }
    const current = state.engine
    if (current && config && sameSttRecognizerConfig(current, config)) {
      return
    }
    // An idle recognizer for a model that is no longer the selected one.
    if (current) {
      await teardownSttEngine(state, current)
      continue
    }
    if (!manifest || !config || !ready || state.prewarmFailedModelId === modelId) {
      return
    }
    const engine = spawnSttEngine(state, config, manifest)
    try {
      await engine.ready
    } catch (error) {
      if (!engine.retired) {
        state.prewarmFailedModelId = modelId
        console.warn('[speech] Model pre-warm failed:', modelId, error)
      }
      return
    }
    if (state.engine === engine && sttEngineUsers(state, engine).length === 0) {
      scheduleSttIdleTeardown(state)
    }
    return
  }
}
