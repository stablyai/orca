import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { SpeechModelDownloadFile } from '../../shared/speech-types'

/** Whether every listed file is in `modelDir` at its expected size. */
export function hasSpeechModelFiles(
  files: readonly SpeechModelDownloadFile[] | undefined,
  modelDir: string
): boolean {
  if (!files) {
    return false
  }
  return files.every(({ name, sizeBytes }) => {
    try {
      return statSync(join(modelDir, name)).size === sizeBytes
    } catch {
      return false
    }
  })
}
