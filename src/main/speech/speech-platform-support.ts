import type { SpeechModelManifest } from '../../shared/speech-types'
import transcribeCppPackages from '../../shared/transcribe-cpp-packages.json'

export function supportsLocalSpeechRecognition(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): boolean {
  return Object.hasOwn(transcribeCppPackages, `${platform}-${architecture}`)
}

export function getSupportedSpeechModels(
  models: SpeechModelManifest[],
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): SpeechModelManifest[] {
  if (supportsLocalSpeechRecognition(platform, architecture)) {
    return models
  }
  // Offer cloud models when the packaged speech engine has no native build for this host.
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
