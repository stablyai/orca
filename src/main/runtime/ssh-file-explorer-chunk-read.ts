import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import type { RuntimeFileReadChunkResult } from '../../shared/runtime-types'
import { FileRangeReadUnsupportedError, type IFilesystemProvider } from '../providers/types'

export const SSH_RANGED_READ_UNAVAILABLE_MESSAGE =
  'This SSH host cannot serve ranged file reads; reconnect the SSH target to update its Orca helper and retry'

/**
 * Serves one `readFileExplorerChunk` window from an SSH host, mirroring the local positional read.
 * The host refuses a window wider than its range cap rather than clamping it, so a caller-sized
 * window is paged into bounded reads here instead of failing the whole chunk.
 */
export async function readSshFileExplorerChunk(
  provider: IFilesystemProvider,
  filePath: string,
  fileSize: number,
  offset: number,
  length: number
): Promise<RuntimeFileReadChunkResult> {
  const readFileRange = provider.readFileRange?.bind(provider)
  if (!readFileRange) {
    throw new Error(SSH_RANGED_READ_UNAVAILABLE_MESSAGE)
  }
  const want = Math.min(length, Math.max(0, fileSize - offset))
  const windows: Buffer[] = []
  let bytesRead = 0
  while (bytesRead < want) {
    const windowLength = Math.min(MAX_FILE_RANGE_READ_BYTES, want - bytesRead)
    let window
    try {
      window = await readFileRange(filePath, offset + bytesRead, windowLength)
    } catch (error) {
      if (error instanceof FileRangeReadUnsupportedError) {
        throw new Error(SSH_RANGED_READ_UNAVAILABLE_MESSAGE)
      }
      throw error
    }
    windows.push(window.bytes)
    bytesRead += window.bytesRead
    // A short window means EOF, so the file shrank under the stat: stop instead of spinning. This
    // chunk reports `eof` false, but the caller's next chunk re-stats the smaller file and ends the
    // transfer short — the same silent outcome the local branch produces, fixable only in both.
    if (window.bytesRead < windowLength) {
      break
    }
  }
  return {
    contentBase64: Buffer.concat(windows).toString('base64'),
    bytesRead,
    eof: offset + bytesRead >= fileSize
  }
}
