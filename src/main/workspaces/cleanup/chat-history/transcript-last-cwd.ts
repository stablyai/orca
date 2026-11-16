import { open, stat } from 'node:fs/promises'
import { WORKSPACE_CLEANUP_RULE_GRACE_MS } from '../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { goneFolderKey, goneFolderOf } from './deleted-workspace-folders'

const CHUNK_BYTES = 256 * 1024
const MAX_SCAN_BYTES = 16 * 1024 * 1024
const NEWLINE = 0x0a

/** The record's own top-level cwd; tool arguments nested inside can carry other folders. */
function topLevelCwd(line: Buffer): string | null {
  if (!line.includes('"cwd"')) {
    return null
  }
  try {
    const record: unknown = JSON.parse(line.toString('utf8'))
    const cwd =
      typeof record === 'object' && record !== null ? (record as { cwd?: unknown }).cwd : null
    return typeof cwd === 'string' ? cwd : null
  } catch {
    return null
  }
}

/** The last top-level `cwd` a JSONL transcript recorded, reading whole records back from its end. */
async function readLastRecordedCwd(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    // Pieces of the record that straddles chunk boundaries, oldest first; joined once it is whole.
    let pieces: Buffer[] = []
    for (let end = size; end > 0 && size - end < MAX_SCAN_BYTES; end -= CHUNK_BYTES) {
      const start = Math.max(0, end - CHUNK_BYTES)
      const chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      // Long API blobs carry no cwd, so keep reading back until a record with one appears.
      let lineEnd = chunk.length
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== NEWLINE) {
          continue
        }
        const head = chunk.subarray(index + 1, lineEnd)
        const cwd = topLevelCwd(pieces.length > 0 ? Buffer.concat([head, ...pieces]) : head)
        if (cwd !== null) {
          return cwd
        }
        pieces = []
        lineEnd = index
      }
      pieces.unshift(chunk.subarray(0, lineEnd))
      if (start === 0) {
        return topLevelCwd(Buffer.concat(pieces))
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Re-read right before deletion: still idle, and not resumed elsewhere since. Orca resumes a chat
 * whose folder is gone at a live workspace's root (#17745), and the transcript keeps its first cwd.
 */
export async function isStillIdleInGoneFolder(
  filePath: string,
  folderKey: string,
  now: number
): Promise<boolean> {
  try {
    if (now - (await stat(filePath)).mtimeMs < WORKSPACE_CLEANUP_RULE_GRACE_MS) {
      return false
    }
    // No recorded location means no proof the chat stayed in the gone folder: keep it.
    const lastCwd = await readLastRecordedCwd(filePath)
    if (lastCwd === null) {
      return false
    }
    const lastFolder = await goneFolderOf(lastCwd)
    return lastFolder !== null && goneFolderKey(lastFolder) === folderKey
  } catch {
    return false
  }
}
