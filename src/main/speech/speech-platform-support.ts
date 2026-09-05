import {
  LOCAL_SPEECH_UNAVAILABLE_ERROR_CODE,
  type SpeechModelManifest
} from '../../shared/speech-types'
import { isWindowsArm64 } from '../windows-arm64'

export { LOCAL_SPEECH_UNAVAILABLE_ERROR_CODE }

export function supportsLocalSpeechRecognition(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): boolean {
  return !isWindowsArm64(platform, architecture)
}

export function getSupportedSpeechModels(
  models: SpeechModelManifest[],
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): SpeechModelManifest[] {
  if (supportsLocalSpeechRecognition(platform, architecture)) {
    return models
  }
  // Why: the published sherpa Node addon has no Windows ARM64 binary; keep
  // cloud transcription available without offering downloads that cannot run.
  return models.filter((model) => model.provider !== 'local')
}

export function getSupportedSpeechModelSelection(
  selectedModelId: string,
  models: SpeechModelManifest[],
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): string {
  if (!selectedModelId) {
    return ''
  }
  return getSupportedSpeechModels(models, platform, architecture).some(
    (model) => model.id === selectedModelId
  )
    ? selectedModelId
    : ''
}

export function assertLocalSpeechRecognitionSupported(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): void {
  if (!supportsLocalSpeechRecognition(platform, architecture)) {
    throw new Error(LOCAL_SPEECH_UNAVAILABLE_ERROR_CODE)
  }
}
