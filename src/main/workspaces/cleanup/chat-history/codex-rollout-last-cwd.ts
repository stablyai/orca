import { createReadStream } from 'node:fs'
import {
  isZstdTranscriptPath,
  readZstdTranscriptSlice,
  zstdTranscriptStream
} from '../../../native-chat/transcript-streaming/transcript-zstd-decompression'
import { isStillIdleInGoneFolder, readLastRecordedCwd } from './transcript-last-cwd'

// Archived rollouts measured up to 32 MB unpacked; a larger one is kept rather than held in memory.
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
const NEWLINE = 0x0a

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Codex nests the cwd in `payload`: `session_meta` holds the start folder, `turn_context` each turn's. */
function codexRecordCwd(line: Buffer): string | null {
  if (!line.includes('"cwd"')) {
    return null
  }
  try {
    const record: unknown = JSON.parse(line.toString('utf8'))
    if (
      !isObject(record) ||
      (record.type !== 'session_meta' && record.type !== 'turn_context') ||
      !isObject(record.payload)
    ) {
      return null
    }
    return typeof record.payload.cwd === 'string' ? record.payload.cwd : null
  } catch {
    return null
  }
}

/** `.jsonl.zst` can't be read from its end, so it is unpacked whole and read back from there. */
async function readLastArchivedRolloutCwd(filePath: string): Promise<string | null> {
  const raw = createReadStream(filePath)
  const unpacked = zstdTranscriptStream(raw)
  try {
    const text = await readZstdTranscriptSlice(unpacked, MAX_UNPACKED_BYTES + 1)
    if (text.length > MAX_UNPACKED_BYTES) {
      return null
    }
    for (let end = text.length; end > 0;) {
      const start = text.lastIndexOf(NEWLINE, end - 1) + 1
      const cwd = codexRecordCwd(text.subarray(start, end))
      if (cwd !== null) {
        return cwd
      }
      end = start - 1
    }
    return null
  } finally {
    unpacked.destroy()
    raw.destroy()
  }
}

function readLastRolloutCwd(filePath: string): Promise<string | null> {
  return isZstdTranscriptPath(filePath)
    ? readLastArchivedRolloutCwd(filePath)
    : readLastRecordedCwd(filePath, codexRecordCwd)
}

/** Re-read right before deletion: idle, and its last turn ran in the gone folder, not where it was resumed. */
export function isCodexRolloutStillIdleInGoneFolder(
  filePath: string,
  folderKey: string,
  now: number
): Promise<boolean> {
  return isStillIdleInGoneFolder(filePath, folderKey, now, readLastRolloutCwd)
}
