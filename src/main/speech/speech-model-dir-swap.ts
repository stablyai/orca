import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'

export function previousSpeechModelDir(modelDir: string): string {
  return `${modelDir}.previous`
}

/** Moves the old download aside instead of deleting it, so a failed rename (e.g. a Windows file lock) keeps it. */
export async function swapInSpeechModelDir(stagingDir: string, modelDir: string): Promise<void> {
  const previousDir = previousSpeechModelDir(modelDir)
  // Left by an interrupted swap; the staged download is complete, so it is no longer needed.
  await rm(previousDir, { recursive: true, force: true })
  const hadPrevious = existsSync(modelDir)
  if (hadPrevious) {
    await rename(modelDir, previousDir)
  }
  try {
    await rename(stagingDir, modelDir)
  } catch (error) {
    if (hadPrevious) {
      await rename(previousDir, modelDir).catch((restoreError: unknown) => {
        console.error('[speech] Failed to restore the previous model files:', restoreError)
      })
    }
    throw error
  }
  await rm(previousDir, { recursive: true, force: true }).catch(() => undefined)
}
