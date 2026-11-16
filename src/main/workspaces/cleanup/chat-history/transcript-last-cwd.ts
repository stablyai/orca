import { open, stat } from 'node:fs/promises'
import { WORKSPACE_CLEANUP_RULE_GRACE_MS } from '../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { goneFolderKey, goneFolderOf } from './deleted-workspace-folders'

const TAIL_BYTES = 64 * 1024
const CWD_FIELD = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g

/** The last `"cwd"` a transcript recorded, from its final 64 KB; null when it records none there. */
async function readLastRecordedCwd(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length)
    let last: string | null = null
    for (const match of buffer.toString('utf8').matchAll(CWD_FIELD)) {
      last = match[1]
    }
    const parsed: unknown = last === null ? null : JSON.parse(last)
    return typeof parsed === 'string' ? parsed : null
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
    const lastCwd = await readLastRecordedCwd(filePath)
    if (lastCwd === null) {
      return true
    }
    const lastFolder = await goneFolderOf(lastCwd)
    return lastFolder !== null && goneFolderKey(lastFolder) === folderKey
  } catch {
    return false
  }
}
