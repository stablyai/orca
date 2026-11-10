import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { piSessionHistorySessionsDir } from '../ai-vault/agent-sessions-dir'

const SESSION_LOG_EXTENSION = '.jsonl'

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Pi writes one log per session directly under each cwd bucket; nested folders hold OMP artifacts. */
export async function listPiSessionLogFiles(
  sessionsDir = piSessionHistorySessionsDir()
): Promise<string[]> {
  let buckets: string[]
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true })
    buckets = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    // Missing roots mean no data; other unreadable roots must surface scan errors.
    if (isMissingPathError(error)) {
      return []
    }
    throw error
  }
  const logs: string[] = []
  for (const bucket of buckets) {
    const bucketDir = join(sessionsDir, bucket)
    try {
      for (const entry of await readdir(bucketDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(SESSION_LOG_EXTENSION)) {
          logs.push(join(bucketDir, entry.name))
        }
      }
    } catch {
      // A bucket removed mid-scan holds no logs.
    }
  }
  // Sorted paths make fork-copy ownership deterministic.
  return logs.sort((left, right) => left.localeCompare(right))
}
