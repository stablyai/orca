import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
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
    return [join(resourcesPath, 'node_modules')]
  }
  if (getAppEnvironment().isPackaged()) {
    // orcad: only the installed app's copy, which `orca serve` names.
    const handed = process.env[SPEECH_RECOGNIZER_DIR_ENV]
    return handed ? [handed] : []
  }
  return require.resolve.paths('transcribe-cpp') ?? []
}

// The app's engine packages don't change while it runs, so they are looked up once.
let speechEngineModulesDir: string | null | undefined

/** The node_modules directory holding transcribe-cpp, or null on hosts without it. */
export function getSpeechEngineModulesDir(): string | null {
  if (speechEngineModulesDir === undefined) {
    speechEngineModulesDir =
      speechNodeModulesDirCandidates().find((dir) => hasSpeechEnginePackage(dir)) ?? null
  }
  return speechEngineModulesDir
}

export function hasLocalSpeechRecognizer(): boolean {
  return getSpeechEngineModulesDir() !== null
}
