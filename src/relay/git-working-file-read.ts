import { stat } from 'node:fs/promises'
import { bufferToBlob } from './git-handler-utils'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../shared/node-bounded-file-reader'

const MAX_RELAY_DIFF_WORKING_FILE_BYTES = 10 * 1024 * 1024

export async function readWorkingDiffFile(
  absPath: string
): Promise<{ content: string; isBinary: boolean; missing: boolean }> {
  let fileStat
  try {
    fileStat = await stat(absPath)
  } catch (error) {
    // Why: ENOENT means the working-tree file is genuinely gone (a deletion);
    // any other stat error is a read failure we must not mistake for one, since
    // callers fall back to the original bytes only for a proven deletion.
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    return { content: '', isBinary: false, missing }
  }
  if (!fileStat.isFile()) {
    return { content: '', isBinary: false, missing: true }
  }
  try {
    const { buffer } = await readNodeFileWithinLimit(absPath, MAX_RELAY_DIFF_WORKING_FILE_BYTES)
    // Why: bufferToBlob needs the path's extension to know an image is
    // previewable; omitting it made every relay-side binary diff empty.
    return { ...bufferToBlob(buffer, absPath), missing: false }
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      // Why: mirror local git diff reads, which classify blobs over 10MB as binary.
      return { content: '', isBinary: true, missing: false }
    }
    // Why: the file exists but could not be read — a read failure, not a deletion.
    return { content: '', isBinary: false, missing: false }
  }
}
