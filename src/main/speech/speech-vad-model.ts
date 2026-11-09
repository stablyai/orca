import { statSync } from 'node:fs'
import { join } from 'node:path'
import { getCatalogModel } from './model-catalog'
import { SILERO_VAD_MODEL, type SpeechModelDownload } from './model-download-catalog'
import type { ModelManager } from './model-manager'

/** A catalog model, or the VAD helper the model manager downloads the same way but never lists. */
export function speechModelDownload(modelId: string): SpeechModelDownload | undefined {
  return modelId === SILERO_VAD_MODEL.id ? SILERO_VAD_MODEL : getCatalogModel(modelId)
}

/** Fetch the VAD for later dictations; until it lands, offline text arrives at stop as before. */
export function downloadSileroVadInBackground(models: Pick<ModelManager, 'downloadModel'>): void {
  models.downloadModel(SILERO_VAD_MODEL.id).catch((error: unknown) => {
    console.warn('[speech] Silero VAD download failed:', error)
  })
}

// Settings never lists the VAD, so once its file is in place it stays; only a new models folder rechecks.
let verifiedVadPath: string | undefined

/** The downloaded Silero VAD file; when it's missing, starts fetching it and returns undefined. */
export function sileroVadModelPath(
  models: Pick<ModelManager, 'downloadModel' | 'getModelDir'>
): string | undefined {
  const [file] = SILERO_VAD_MODEL.downloadFiles
  const path = join(models.getModelDir(SILERO_VAD_MODEL.id), file.name)
  if (path === verifiedVadPath) {
    return path
  }
  try {
    if (statSync(path).size === file.sizeBytes) {
      verifiedVadPath = path
      return path
    }
  } catch {
    // Not downloaded yet, e.g. the model came before VAD support.
  }
  downloadSileroVadInBackground(models)
  return undefined
}
