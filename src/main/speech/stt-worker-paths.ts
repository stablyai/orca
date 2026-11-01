import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  SPEECH_RECOGNIZER_DIR_ENV,
  speechRecognizerPackageName
} from '../../shared/speech-recognizer-package'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'

/** Mobile maps voice_model_not_ready: to host-supported model setup, including hosts with no recognizer. */
export const LOCAL_SPEECH_UNAVAILABLE_ERROR = 'voice_model_not_ready:unavailable'

export function getSttWorkerPath(): string {
  return resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), 'stt-worker.js')
}

/** Recognizer directory, or null on hosts without one. */
export function getSherpaModulePath(): string | null {
  const nativePackage = speechRecognizerPackageName(process.platform, process.arch)
  const resourcesPath =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : undefined

  if (getAppEnvironment().isPackaged() && resourcesPath) {
    const resourcesNodeModule = join(resourcesPath, 'node_modules', nativePackage)
    if (existsSync(resourcesNodeModule)) {
      return resourcesNodeModule
    }
    return join(resourcesPath, 'app.asar.unpacked', 'node_modules', nativePackage)
  }
  if (getAppEnvironment().isPackaged()) {
    // orcad: only the installed app's copy, which `orca serve` names.
    const handed = process.env[SPEECH_RECOGNIZER_DIR_ENV]
    return handed && existsSync(join(handed, 'sherpa-onnx.node')) ? handed : null
  }

  try {
    return join(require.resolve(nativePackage), '..')
  } catch {
    return null
  }
}

export function hasLocalSpeechRecognizer(): boolean {
  return getSherpaModulePath() !== null
}
