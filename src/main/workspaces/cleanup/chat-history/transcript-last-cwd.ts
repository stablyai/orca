import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
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
    const cwd = typeof record === 'object' && record !== null && 'cwd' in record ? record.cwd : null
    return typeof cwd === 'string' ? cwd : null
  } catch {
    return null
  }
}

/** The last cwd a JSONL transcript recorded, reading whole records back from its end. */
export async function readLastRecordedCwd(
  filePath: string,
  recordCwd: (line: Buffer) => string | null = topLevelCwd
): Promise<string | null> {
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
        const cwd = recordCwd(pieces.length > 0 ? Buffer.concat([head, ...pieces]) : head)
        if (cwd !== null) {
          return cwd
        }
        pieces = []
        lineEnd = index
      }
      pieces.unshift(chunk.subarray(0, lineEnd))
      if (start === 0) {
        return recordCwd(Buffer.concat(pieces))
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
  now: number,
  readLastCwd: (filePath: string) => Promise<string | null> = readLastRecordedCwd
): Promise<boolean> {
  try {
    if (now - (await stat(filePath)).mtimeMs < WORKSPACE_CLEANUP_RULE_GRACE_MS) {
      return false
    }
    // No recorded location means no proof the chat stayed in the gone folder: keep it.
    const lastCwd = await readLastCwd(filePath)
    if (lastCwd === null) {
      return false
    }
    const lastFolder = await goneFolderOf(lastCwd)
    return lastFolder !== null && goneFolderKey(lastFolder) === folderKey
  } catch {
    return false
  }
}

const COMPANION_FILE_LIMIT = 2000

/** Files the chat's removal also deletes: Claude keeps subagent transcripts in `<dir>/<session id>/`. Null when unreadable. */
async function companionFiles(filePath: string): Promise<string[] | null> {
  const files: string[] = []
  const pending = [join(dirname(filePath), basename(filePath, extname(filePath)))]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? [] : null)
    )
    // An unreadable folder may hold a live subagent's transcript: keep the chat.
    if (entries === null) {
      return null
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else {
        files.push(path)
      }
    }
    if (files.length > COMPANION_FILE_LIMIT) {
      return null
    }
  }
  return files
}

/** The chat and every companion it deletes with it: all idle, all last written in the gone folder. */
export async function isChatStillIdleInGoneFolder(
  filePath: string,
  folderKey: string,
  now: number
): Promise<boolean> {
  const before = await fileVersion(filePath)
  if (before === null || !(await isStillIdleInGoneFolder(filePath, folderKey, now))) {
    return false
  }
  const companions = await companionFiles(filePath)
  if (companions === null) {
    return false
  }
  const versions = new Map<string, string | null>()
  for (const companion of companions) {
    versions.set(companion, await fileVersion(companion))
    const idle = companion.endsWith('.jsonl')
      ? await isStillIdleInGoneFolder(companion, folderKey, now)
      : await stat(companion).then(
          (stats) => now - stats.mtimeMs >= WORKSPACE_CLEANUP_RULE_GRACE_MS,
          () => false
        )
    if (!idle) {
      return false
    }
  }
  // Checking takes a while: the chat or a subagent may have been resumed meanwhile, or a new one added.
  if ((await fileVersion(filePath)) !== before) {
    return false
  }
  const after = await companionFiles(filePath)
  if (after === null || after.length !== companions.length) {
    return false
  }
  for (const companion of after) {
    if (!versions.has(companion) || (await fileVersion(companion)) !== versions.get(companion)) {
      return false
    }
  }
  return true
}

async function fileVersion(filePath: string): Promise<string | null> {
  return stat(filePath, { bigint: true }).then(
    (stats) => `${stats.size}:${stats.mtimeNs}`,
    () => null
  )
}
