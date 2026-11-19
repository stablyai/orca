import { createHash, randomUUID } from 'node:crypto'
import { readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
const lastSweepAt = new Map<string, number>()
// Staging files of hand-offs still being written, however long one pauses; the sweep leaves them.
const staging = new Set<string>()
// When each snapshot was last published here, in case its file times couldn't be set.
const publishedAt = new Map<string, number>()

// Temp isn't emptied everywhere (Windows never), and a hand-off can carry every byte of huge outputs.
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const SNAPSHOT_FOLDER_MAX_BYTES = 1024 * 1024 * 1024
// The size cap never takes a hand-off this fresh, which its agent may be reading now.
const SNAPSHOT_MIN_AGE_MS = 60 * 60 * 1000
// Hand-offs sweep at most this often, so repeated ones don't rescan an unchanged folder each time.
const SNAPSHOT_SWEEP_INTERVAL_MS = 60 * 60 * 1000

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
  staging.add(temporary)
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
      published = await runKeyedSerializedOperation(publications, path, async () => {
        if (!(await renameFileWithWindowsRetryAsync(temporary, path, isCurrent))) {
          return false
        }
        // Rename keeps the last write's time, which a paused capture can leave old; the sweep ages
        // by it. Dated inside the queue, so no sweep's delete of this path can run in between.
        const now = new Date()
        await utimes(path, now, now).catch(() => undefined)
        publishedAt.set(path, Date.now())
        return true
      })
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      staging.delete(temporary)
    }
    // Cleanup can yield to a newer capture after this attempt's rename completed.
    if (!published || !isCurrent()) {
      throw new Error('Chat context snapshot publication was replaced')
    }
    // Fresh as of the return itself, however long the awaits above took; nothing awaits after this.
    publishedAt.set(path, Date.now())
    const lastSweep = lastSweepAt.get(root)
    if (lastSweep === undefined || Date.now() - lastSweep >= SNAPSHOT_SWEEP_INTERVAL_MS) {
      void sweepAgentSessionContextSnapshots(root)
    }
    return path
  } finally {
    if (isCurrent()) {
      claims.delete(path)
    }
  }
}

/**
 * Removes snapshots unchanged for a week, crashed parts, then the oldest until the folder fits its
 * cap, so deleted chats' and workspaces' hand-offs can't pile up. Runs off the hand-off, at most
 * hourly from hand-offs; never fails one.
 */
export function sweepAgentSessionContextSnapshots(root: string): Promise<void> {
  const running = sweeps.get(root)
  if (running) {
    return running
  }
  lastSweepAt.set(root, Date.now())
  const sweep = sweepSnapshotFolder(root, Date.now())
    .catch((error) => console.warn('[agent-session-context] snapshot sweep failed', error))
    .finally(() => sweeps.delete(root))
  sweeps.set(root, sweep)
  return sweep
}

async function sweepSnapshotFolder(root: string, now: number): Promise<void> {
  for (const [path, at] of publishedAt) {
    if (now - at >= SNAPSHOT_MAX_AGE_MS) {
      publishedAt.delete(path)
    }
  }
  const files: { path: string; size: number; modified: number }[] = []
  for (const name of await readdir(root)) {
    const path = join(root, name)
    const part = name.endsWith('.part')
    const info = part || name.endsWith('.txt') ? await stat(path).catch(() => null) : null
    if (!info?.isFile()) {
      continue
    }
    const age = now - info.mtimeMs
    if (part) {
      if (age > SNAPSHOT_MIN_AGE_MS && !staging.has(path)) {
        await rm(path, { force: true }).catch(() => undefined)
      }
    } else if (
      age <= SNAPSHOT_MAX_AGE_MS ||
      !(await removeSnapshot(path, now, SNAPSHOT_MAX_AGE_MS))
    ) {
      files.push({ path, size: info.size, modified: info.mtimeMs })
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files.sort((a, b) => a.modified - b.modified)) {
    if (total <= SNAPSHOT_FOLDER_MAX_BYTES || now - file.modified < SNAPSHOT_MIN_AGE_MS) {
      return
    }
    if (await removeSnapshot(file.path, now, SNAPSHOT_MIN_AGE_MS)) {
      total -= file.size
    }
  }
}

/** In the path's publication queue, so a hand-off republished since the scan is never taken. */
function removeSnapshot(path: string, now: number, minAge: number): Promise<boolean> {
  return runKeyedSerializedOperation(publications, path, async () => {
    const info = await stat(path).catch(() => null)
    const published = Math.max(info?.mtimeMs ?? 0, publishedAt.get(path) ?? 0)
    if (claims.has(path) || !info || now - published < minAge) {
      return false
    }
    // A file another process holds open (Windows) waits for a later sweep.
    return rm(path, { force: true }).then(
      () => true,
      () => false
    )
  })
}
