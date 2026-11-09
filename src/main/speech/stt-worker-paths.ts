import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { speechEngineForModelFiles, type SpeechEngine } from '../../shared/speech-model-engine'
import {
  hasSpeechEnginePackage,
  SPEECH_RECOGNIZER_DIR_ENV
} from '../../shared/speech-recognizer-package'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'

/** Mobile maps voice_model_not_ready: to host-supported model setup, including hosts with no recognizer. */
export const LOCAL_SPEECH_UNAVAILABLE_ERROR = 'voice_model_not_ready:unavailable'

export function getSttWorkerPath(): string {
  return resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), 'stt-worker.js')
}

function speechNodeModulesDirCandidates(): string[] {
  const resourcesPath =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : undefined
  if (getAppEnvironment().isPackaged() && resourcesPath) {
    return [
      join(resourcesPath, 'node_modules'),
      join(resourcesPath, 'app.asar.unpacked', 'node_modules')
    ]
  }
  if (getAppEnvironment().isPackaged()) {
    // orcad: only the installed app's copy, which `orca serve` names.
    const handed = process.env[SPEECH_RECOGNIZER_DIR_ENV]
    return handed ? [handed] : []
  }
  return require.resolve.paths('transcribe-cpp') ?? []
}

// The app's engine packages don't change while it runs, so each engine is looked up once.
const speechEngineModulesDirs = new Map<SpeechEngine, string | null>()

/** The node_modules directory holding `engine`, or null on hosts without it. */
export function getSpeechEngineModulesDir(engine: SpeechEngine): string | null {
  let dir = speechEngineModulesDirs.get(engine)
  if (dir === undefined) {
    dir =
      speechNodeModulesDirCandidates().find((candidate) =>
        hasSpeechEnginePackage(candidate, engine)
      ) ?? null
    speechEngineModulesDirs.set(engine, dir)
  }
  return dir
}

/** Whether this host ships the engine `model` runs on. */
export function hasLocalSpeechRecognizer(model: { files?: readonly string[] }): boolean {
  return getSpeechEngineModulesDir(speechEngineForModelFiles(model.files ?? [])) !== null
}
