import { readFile, stat } from 'node:fs/promises'
import { bufferToBlob } from './git-handler-utils'

const MAX_RELAY_DIFF_WORKING_FILE_BYTES = 10 * 1024 * 1024

export async function readWorkingDiffFile(
  absPath: string
): Promise<{ content: string; isBinary: boolean }> {
  try {
    const fileStat = await stat(absPath)
    if (!fileStat.isFile()) {
      return { content: '', isBinary: false }
    }
    if (fileStat.size > MAX_RELAY_DIFF_WORKING_FILE_BYTES) {
      // Why: mirror local git diff reads, which cap blob transfer at 10MB.
      return { content: '', isBinary: true }
    }
    const buffer = await readFile(absPath)
    return bufferToBlob(buffer, absPath)
  } catch {
    return { content: '', isBinary: false }
  }
}
