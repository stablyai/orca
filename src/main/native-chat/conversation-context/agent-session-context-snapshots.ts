import { createHash, randomUUID } from 'node:crypto'
import { readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'
import { renameFileWithWindowsRetryAsync } from '../../../shared/file-write/windows-retry-file-operations'
import {
  ensureOwnedTempStagingRoot,
  getOwnedTempStagingRoot
} from '../../filesystem/owned-temp-staging-root'

const claims = new Map<string, object>()
const publications = new Map<string, Promise<void>>()
const sweeps = new Map<string, Promise<void>>()

// Temp isn't emptied everywhere (Windows never), and a hand-off can carry every byte of huge outputs.
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const SNAPSHOT_FOLDER_MAX_BYTES = 1024 * 1024 * 1024
// The size cap never takes a hand-off this fresh, which its agent may be reading now.
const SNAPSHOT_MIN_AGE_MS = 60 * 60 * 1000

export function agentSessionContextSnapshotRoot(stateDirectory: string): string {
  const profile = createHash('sha256').update(resolve(stateDirectory)).digest('hex').slice(0, 16)
  return getOwnedTempStagingRoot(tmpdir(), `orca-handoff-${profile}`)
}

/** One snapshot per chat, replaced on each hand-off and swept by age and folder size. Parts stream to disk in order. */
export async function writeAgentSessionContextSnapshot(
  stateDirectory: string,
  sessionId: string,
  text: string | AsyncIterable<string>
): Promise<string> {
  const root = agentSessionContextSnapshotRoot(stateDirectory)
  const name = createHash('sha256').update(sessionId).digest('hex')
  const path = join(root, `${name}.txt`)
  const temporary = `${path}.${randomUUID()}.part`
  const claim = {}
  claims.set(path, claim)
  const isCurrent = () => claims.get(path) === claim
  let published = false
  try {
    try {
      if (!(await ensureOwnedTempStagingRoot(root))) {
        throw new Error('Chat context snapshot folder is not private')
      }
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
      // Staging can finish out of order; only publication holds the shared path queue.
      published = await runKeyedSerializedOperation(publications, path, () =>
        renameFileWithWindowsRetryAsync(temporary, path, isCurrent)
      )
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    // Cleanup can yield to a newer capture after this attempt's rename completed.
    if (!published || !isCurrent()) {
      throw new Error('Chat context snapshot publication was replaced')
    }
    await sweepAgentSessionContextSnapshots(root, path)
    return path
  } finally {
    if (isCurrent()) {
      claims.delete(path)
    }
  }
}

/**
 * Removes snapshots unchanged for a week, crashed parts, then the oldest until the folder fits its
 * cap, so deleted chats' and workspaces' hand-offs can't pile up. Never fails the hand-off.
 */
export function sweepAgentSessionContextSnapshots(
  root: string,
  keep: string,
  now = Date.now()
): Promise<void> {
  if (!sweeps.has(root)) {
    const sweep = sweepSnapshotFolder(root, keep, now)
      .catch((error) => console.warn('[agent-session-context] snapshot sweep failed', error))
      .finally(() => sweeps.delete(root))
    sweeps.set(root, sweep)
  }
  return sweeps.get(root)!
}

async function sweepSnapshotFolder(root: string, keep: string, now: number): Promise<void> {
  const files: { path: string; size: number; modified: number }[] = []
  for (const name of await readdir(root)) {
    const path = join(root, name)
    const part = name.endsWith('.part')
    if ((!part && !name.endsWith('.txt')) || path === keep) {
      continue
    }
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) {
      continue
    }
    const age = now - info.mtimeMs
    if (age > SNAPSHOT_MAX_AGE_MS || (part && age > SNAPSHOT_MIN_AGE_MS)) {
      await rm(path, { force: true })
    } else if (!part) {
      files.push({ path, size: info.size, modified: info.mtimeMs })
    }
  }
  let total = (await stat(keep).catch(() => null))?.size ?? 0
  total += files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files.sort((a, b) => a.modified - b.modified)) {
    if (total <= SNAPSHOT_FOLDER_MAX_BYTES || now - file.modified < SNAPSHOT_MIN_AGE_MS) {
      return
    }
    await rm(file.path, { force: true })
    total -= file.size
  }
}
