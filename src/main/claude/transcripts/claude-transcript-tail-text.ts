import { open, stat, type FileHandle } from 'node:fs/promises'

/** The last `maxBytes` of a transcript as text; null unless the path is a regular file, since a
 *  FIFO or device would never finish a read. Its first line may be cut. */
export async function readClaudeTranscriptTailText(
  transcriptPath: string,
  maxBytes: number
): Promise<string | null> {
  let file: FileHandle | null = null
  try {
    // Why stat before open: opening a FIFO waits for a writer.
    const stats = await stat(transcriptPath)
    if (!stats.isFile()) {
      return null
    }
    file = await open(transcriptPath, 'r')
    const length = Math.min(stats.size, maxBytes)
    const { buffer, bytesRead } = await file.read(
      Buffer.alloc(length),
      0,
      length,
      stats.size - length
    )
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await file?.close().catch(() => {})
  }
}
