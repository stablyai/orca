import { open, stat } from 'node:fs/promises'
import { WORKSPACE_CLEANUP_RULE_GRACE_MS } from '../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { goneFolderKey, goneFolderOf } from './deleted-workspace-folders'

const CHUNK_BYTES = 256 * 1024
// A cwd value is short; chunks overlap by this much so a match split across a boundary is still read.
const OVERLAP_BYTES = 8 * 1024
const MAX_SCAN_BYTES = 16 * 1024 * 1024
const CWD_FIELD = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g

function lastCwdIn(text: string): string | null {
  let last: string | null = null
  for (const match of text.matchAll(CWD_FIELD)) {
    last = match[1]
  }
  const parsed: unknown = last === null ? null : JSON.parse(last)
  return typeof parsed === 'string' ? parsed : null
}

/** The last `"cwd"` a transcript recorded, read backwards from its end; null when none is found. */
async function readLastRecordedCwd(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    // Long API blobs carry no cwd, so keep reading back until one appears.
    for (let end = size; end > 0 && size - end < MAX_SCAN_BYTES; end -= CHUNK_BYTES) {
      const start = Math.max(0, end - CHUNK_BYTES)
      const length = Math.min(size, end + OVERLAP_BYTES) - start
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, start)
      const cwd = lastCwdIn(buffer.toString('utf8'))
      if (cwd !== null) {
        return cwd
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
