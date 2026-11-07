import { engineDictationLanguage } from '../../shared/dictation-language'
import type { SpeechModelManifest } from '../../shared/speech-types'
import { getCatalogModel } from './model-catalog'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'
import type { SttEventSink } from './stt-service'
import {
  MAX_STT_SESSIONS,
  sameSttRecognizerConfig,
  sttEngineUsers,
  type SttEngine,
  type SttRecognizerConfig,
  type SttSession,
  type SttSessionState
} from './stt-session-state'
import {
  clearSttIdleTeardownTimer,
  failSttEngine,
  releaseSttSession,
  teardownSttEngine
} from './stt-session-stop'
import { getSherpaModulePath, LOCAL_SPEECH_UNAVAILABLE_ERROR } from './stt-worker-paths'
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
    manifest.provider === 'openai'
      ? null
      : { modelId, hotwordsFilePath, language: engineDictationLanguage(manifest, language) }
  if (liveSessions(state).length >= MAX_STT_SESSIONS) {
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
    canceled: false,
    stopPromise: null
  }
  state.sessions.set(owner, session)
  try {
    if (config) {
      const engine = await acquireSttEngine(state, session, config, manifest)
      // Audio fed while the model loads queues in the process behind init.
      session.engine = engine
      await engine.ready
      if (engine.dead) {
        throw new Error(STT_WORKER_EXITED_ERROR)
      }
    } else {
      await requireModelReady(state, modelId)
      // A cloud dictation needs no recognizer; free one nobody else uses.
      const idle = state.engine
      if (idle && sttEngineUsers(state, idle).length === 0) {
        await teardownSttEngine(state, idle)
      }
      session.cloud = new OpenAiTranscriptionSession(
        modelId,
        readOpenAiSpeechApiKey,
        engineDictationLanguage(manifest, language)
      )
    }
    if (session.canceled) {
      throw new Error('dictation_canceled')
    }
    session.phase = 'active'
    sink({ type: 'ready' })
  } catch (error) {
    session.cloud?.cancel()
    releaseSttSession(state, session)
    throw error
  }
}

// Sessions share one recognizer, so a second model would load another copy; refuse it while others use the first.
function conflictingSessions(state: SttSessionState, config: SttRecognizerConfig): SttSession[] {
  return liveSessions(state).filter(
    (other) => other.config && !sameSttRecognizerConfig(other.config, config)
  )
}

// A canceled start only waits out its model load; it holds no device's slot.
function liveSessions(state: SttSessionState): SttSession[] {
  return [...state.sessions.values()].filter((session) => !session.canceled)
}

async function requireModelReady(state: SttSessionState, modelId: string): Promise<void> {
  const modelState = await state.modelManager.getModelState(modelId)
  if (modelState.status !== 'ready') {
    const idle = state.engine
    if (idle?.modelId === modelId && sttEngineUsers(state, idle).length === 0) {
      await teardownSttEngine(state, idle)
    }
    throw new Error(`Model not ready: ${modelState.status}`)
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
    if (session.canceled) {
      throw new Error('dictation_canceled')
    }
    const conflicts = conflictingSessions(state, config)
    if (conflicts.some((other) => other.phase !== 'stopping')) {
      throw new Error('dictation_model_busy')
    }
    if (conflicts.length > 0) {
      await Promise.allSettled(conflicts.map((other) => other.stopPromise))
      continue
    }
    const current = state.engine
    if (current && sameSttRecognizerConfig(current, config)) {
      clearSttIdleTeardownTimer(state)
      return current
    }
    if (!current) {
      return spawnSttEngine(state, config, manifest)
    }
    // Only canceled starts can still wait on a recognizer with another config.
    await teardownSttEngine(state, current)
  }
}

function spawnSttEngine(
  state: SttSessionState,
  config: SttRecognizerConfig,
  manifest: SpeechModelManifest
): SttEngine {
  const sherpaModulePath = getSherpaModulePath()
  if (!sherpaModulePath) {
    throw new Error(LOCAL_SPEECH_UNAVAILABLE_ERROR)
  }
  clearSttIdleTeardownTimer(state)
  const worker = state.spawnWorker()
  const readyPromise = waitForSttWorkerReady(worker, START_DICTATION_TIMEOUT_MS)
  const engine: SttEngine = {
    ...config,
    worker,
    dead: false,
    detach: () => undefined,
    ready: readyPromise.catch((error: unknown) => {
      failSttEngine(state, engine, STT_WORKER_EXITED_ERROR)
      throw error
    })
  }
  // Every awaiting session sees the rejection; this only keeps an unawaited one from being reported.
  engine.ready.catch(() => undefined)
  engine.detach = attachSttWorkerLifecycle({
    worker,
    isCurrent: () => !engine.dead,
    onMessage: (event) => {
      const { streamId, ...sessionEvent } = event
      const session = sttEngineUsers(state, engine).find((user) => user.streamId === streamId)
      session?.sink(sessionEvent)
    },
    onError: (error) => failSttEngine(state, engine, String(error)),
    onExit: () => failSttEngine(state, engine, STT_WORKER_EXITED_ERROR)
  })
  state.engine = engine
  initializeSttWorker(worker, {
    sherpaModulePath,
    modelDir: state.modelManager.getModelDir(config.modelId),
    modelType: manifest.type,
    streaming: manifest.streaming,
    sampleRate: manifest.sampleRate,
    files: manifest.files ?? [],
    hotwordsFilePath: config.hotwordsFilePath,
    modelingUnit: manifest.modelingUnit,
    language: config.language
  })
  return engine
}
