import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'

export function previousSpeechModelDir(modelDir: string): string {
  return `${modelDir}.previous`
}

/** Moves the old download aside instead of deleting it, so a failed rename (e.g. a Windows file lock) keeps it. */
export async function swapInSpeechModelDir(stagingDir: string, modelDir: string): Promise<void> {
  const previousDir = previousSpeechModelDir(modelDir)
  // With no modelDir, previousDir is the old copy an interrupted swap left; keep it until the new one is in.
  if (existsSync(modelDir)) {
    await rm(previousDir, { recursive: true, force: true })
    await renameFileWithWindowsRetryAsync(modelDir, previousDir)
  }
  try {
    await renameFileWithWindowsRetryAsync(stagingDir, modelDir)
  } catch (error) {
    if (existsSync(previousDir)) {
      await renameFileWithWindowsRetryAsync(previousDir, modelDir).catch(
        (restoreError: unknown) => {
          console.error('[speech] Failed to restore the previous model files:', restoreError)
        }
      )
    }
    throw error
  }
  await rm(previousDir, { recursive: true, force: true }).catch(() => undefined)
}
