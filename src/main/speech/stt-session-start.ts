import { SPEECH_MODEL_NEEDS_UPDATE_ERROR } from '../../shared/speech-model-retirement'
import { engineDictationLanguage } from '../../shared/dictation-language'
import type { SpeechModelManifest } from '../../shared/speech-types'
import { getCatalogModel } from './model-catalog'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { resolveCloudTranscriptionTarget } from './cloud-transcription-target'
import type { SttEventSink } from './stt-service'
import {
  MAX_STT_SESSIONS,
  sameSttRecognizerConfig,
  type SttEngine,
  type SttRecognizerConfig,
  type SttSession,
  type SttSessionState
} from './stt-session-state'
import {
  clearSttIdleTeardownTimer,
  failSttEngine,
  releaseSttSession,
  teardownIdleSttEngine,
  teardownSttEngine
} from './stt-session-stop'
import { speechEngineForModelFiles } from '../../shared/speech-model-engine'
import { getSpeechEngineModulesDir, LOCAL_SPEECH_UNAVAILABLE_ERROR } from './stt-worker-paths'
import {
  attachSttWorkerLifecycle,
  initializeSttWorker,
  waitForSttWorkerReady
} from './stt-worker-startup'
import { START_DICTATION_TIMEOUT_MS } from './stt-session-timeouts'
import { STT_WORKER_EXITED_ERROR } from './stt-worker-process'

export async function startSttDictation(
  state: SttSessionState,
  modelId: string,
  sink: SttEventSink,
  hotwordsFilePath?: string,
  owner = 'desktop',
  language?: string
): Promise<void> {
  const existing = state.sessions.get(owner)
  if (existing?.phase === 'starting') {
    return
  }
  if (existing?.phase === 'active') {
    existing.sink = sink
    sink({ type: 'ready' })
    return
  }
  if (existing?.phase === 'stopping') {
    await existing.stopPromise
    return startSttDictation(state, modelId, sink, hotwordsFilePath, owner, language)
  }

  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new Error(`Unknown model: ${modelId}`)
  }
  const config: SttRecognizerConfig | null =
    manifest.provider !== 'local'
      ? null
      : { modelId, hotwordsFilePath, language: engineDictationLanguage(manifest, language) }
  if (state.sessions.size >= MAX_STT_SESSIONS) {
    throw new Error('dictation_session_limit')
  }
  if (config && conflictingSessions(state, config).some((other) => other.phase !== 'stopping')) {
    throw new Error('dictation_model_busy')
  }

  const session: SttSession = {
    owner,
    streamId: String(state.nextStreamId++),
    sink,
    config,
    modelId,
    engine: null,
    cloud: null,
    phase: 'starting',
    stopPromise: null
  }
  state.sessions.set(owner, session)
  try {
    if (config) {
      // Audio fed while the model loads queues in the process behind init.
      const engine = await acquireSttEngine(state, session, config, manifest)
      await engine.ready
      if (state.engine !== engine) {
        throw new Error(STT_WORKER_EXITED_ERROR)
      }
    } else {
      await requireModelReady(state, modelId)
      // A cloud dictation needs no recognizer; free one nobody else uses.
      await teardownIdleSttEngine(state)
      session.cloud = new OpenAiTranscriptionSession(
        () => resolveCloudTranscriptionTarget(modelId),
        engineDictationLanguage(manifest, language)
      )
    }
    throwIfCanceled(state, session)
    session.phase = 'active'
    state.prewarmFailedModelId = null
    sink({ type: 'ready' })
  } catch (error) {
    session.cloud?.cancel()
    releaseSttSession(state, session)
    throw error
  }
}

// Sessions share one recognizer, so a second model would load another copy; refuse it while others use the first.
function conflictingSessions(state: SttSessionState, config: SttRecognizerConfig): SttSession[] {
  return [...state.sessions.values()].filter(
    (other) => other.config && !sameSttRecognizerConfig(other.config, config)
  )
}

// A stop during start drops the session from the map; the start notices once its model is loaded.
function throwIfCanceled(state: SttSessionState, session: SttSession): void {
  if (state.sessions.get(session.owner) !== session) {
    throw new Error('dictation_canceled')
  }
}

async function requireModelReady(state: SttSessionState, modelId: string): Promise<void> {
  const modelState = await state.modelManager.getModelState(modelId)
  if (modelState.status !== 'ready') {
    await teardownIdleSttEngine(state, modelId)
    throw new Error(
      modelState.needsUpdate
        ? SPEECH_MODEL_NEEDS_UPDATE_ERROR
        : `Model not ready: ${modelState.status}`
    )
  }
}

async function acquireSttEngine(
  state: SttSessionState,
  session: SttSession,
  config: SttRecognizerConfig,
  manifest: SpeechModelManifest
): Promise<SttEngine> {
  await requireModelReady(state, config.modelId)
  for (;;) {
    throwIfCanceled(state, session)
    const conflicts = conflictingSessions(state, config)
    if (conflicts.some((other) => other.phase !== 'stopping')) {
      throw new Error('dictation_model_busy')
    }
    if (conflicts.length > 0) {
      await Promise.allSettled(conflicts.map((other) => other.stopPromise ?? Promise.resolve()))
      continue
    }
    const current = state.engine
    // Bound in the same step it is chosen, so an idle teardown never sees it unused.
    if (current && sameSttRecognizerConfig(current, config)) {
      clearSttIdleTeardownTimer(state)
      session.engine = current
      return current
    }
    if (!current) {
      session.engine = spawnSttEngine(state, config, manifest)
      return session.engine
    }
    // No session uses a recognizer with another config, so it is idle.
    await teardownSttEngine(state, current)
  }
}

export function spawnSttEngine(
  state: SttSessionState,
  config: SttRecognizerConfig,
  manifest: SpeechModelManifest
): SttEngine {
  const files = manifest.files ?? []
  const speechModulesDir = getSpeechEngineModulesDir(speechEngineForModelFiles(files))
  if (!speechModulesDir) {
    throw new Error(LOCAL_SPEECH_UNAVAILABLE_ERROR)
  }
  clearSttIdleTeardownTimer(state)
  const worker = state.spawnWorker()
  const readyPromise = waitForSttWorkerReady(worker, START_DICTATION_TIMEOUT_MS)
  const detach = attachSttWorkerLifecycle({
    worker,
    isCurrent: () => state.engine === engine,
    onMessage: ({ streamId, ...event }) => {
      for (const session of state.sessions.values()) {
        if (session.engine === engine && session.streamId === streamId) {
          session.sink(event)
        }
      }
    },
    onError: (error) => failSttEngine(state, engine, String(error)),
    onExit: () => failSttEngine(state, engine, STT_WORKER_EXITED_ERROR)
  })
  const engine: SttEngine = {
    ...config,
    worker,
    detach,
    retired: false,
    onUnloaded: [],
    ready: readyPromise.catch((error: unknown) => {
      failSttEngine(state, engine, STT_WORKER_EXITED_ERROR)
      throw error
    })
  }
  // Every awaiting session sees the rejection; this only keeps an unawaited one from being reported.
  engine.ready.catch(() => undefined)
  state.engine = engine
  initializeSttWorker(worker, {
    speechModulesDir,
    modelDir: state.modelManager.getModelDir(config.modelId),
    modelType: manifest.type,
    streaming: manifest.streaming,
    sampleRate: manifest.sampleRate,
    files,
    hotwordsFilePath: config.hotwordsFilePath,
    modelingUnit: manifest.modelingUnit,
    language: config.language
  })
  return engine
}
