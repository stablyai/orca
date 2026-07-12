import { isModelInFlight, type MobileSpeechModel } from './mobile-dictation-setup'

function formatSize(bytes: number | null): string {
  return bytes ? `${Math.round(bytes / 1_000_000)} MB` : ''
}

export function formatMobileSpeechModelMetadata(model: MobileSpeechModel): string {
  if (model.provider === 'openai') {
    return 'OpenAI API'
  }
  if (model.provider === 'soniox') {
    return 'Soniox API'
  }
  if (isModelInFlight(model) && model.progress != null) {
    return `${formatSize(model.sizeBytes)} · ${Math.round(model.progress * 100)}%`
  }
  if (model.status === 'extracting') {
    return `${formatSize(model.sizeBytes)} · extracting…`
  }
  return formatSize(model.sizeBytes)
}
