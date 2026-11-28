import { stat } from 'node:fs/promises'

/** Whether a transcript file exists; a missing one is false, any other failure throws. */
export async function isTranscriptFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false
    }
    throw error
  }
}
