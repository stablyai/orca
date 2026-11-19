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
const sweeps = new Map<string, { done: Promise<void>; again: boolean }>()
// Staging files of hand-offs still being written, however long one pauses; the sweep leaves them.
const staging = new Set<string>()

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
      published = await runKeyedSerializedOperation(publications, path, () =>
        renameFileWithWindowsRetryAsync(temporary, path, isCurrent)
      )
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      staging.delete(temporary)
    }
    // Cleanup can yield to a newer capture after this attempt's rename completed.
    if (!published || !isCurrent()) {
      throw new Error('Chat context snapshot publication was replaced')
    }
    void sweepAgentSessionContextSnapshots(root)
    return path
  } finally {
    if (isCurrent()) {
      claims.delete(path)
    }
  }
}

/**
 * Removes snapshots unchanged for a week, crashed parts, then the oldest until the folder fits its
 * cap, so deleted chats' and workspaces' hand-offs can't pile up. Runs off the hand-off; never fails it.
 */
export function sweepAgentSessionContextSnapshots(root: string): Promise<void> {
  const running = sweeps.get(root)
  if (running) {
    // A hand-off published after this sweep's listing gets a sweep that counts it.
    running.again = true
    return running.done
  }
  const state = { done: Promise.resolve(), again: false }
  state.done = (async () => {
    do {
      state.again = false
      await sweepSnapshotFolder(root, Date.now()).catch((error) =>
        console.warn('[agent-session-context] snapshot sweep failed', error)
      )
    } while (state.again)
    sweeps.delete(root)
  })()
  sweeps.set(root, state)
  return state.done
}

async function sweepSnapshotFolder(root: string, now: number): Promise<void> {
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
    } else if (age > SNAPSHOT_MAX_AGE_MS) {
      await removeSnapshot(path, now)
    } else {
      files.push({ path, size: info.size, modified: info.mtimeMs })
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0)
  for (const file of files.sort((a, b) => a.modified - b.modified)) {
    if (total <= SNAPSHOT_FOLDER_MAX_BYTES || now - file.modified < SNAPSHOT_MIN_AGE_MS) {
      return
    }
    if (await removeSnapshot(file.path, now)) {
      total -= file.size
    }
  }
}

/** In the path's publication queue, so a hand-off republished since the scan is never taken. */
function removeSnapshot(path: string, now: number): Promise<boolean> {
  return runKeyedSerializedOperation(publications, path, async () => {
    const info = await stat(path).catch(() => null)
    if (claims.has(path) || !info || now - info.mtimeMs < SNAPSHOT_MIN_AGE_MS) {
      return false
    }
    // A file another process holds open (Windows) waits for a later sweep.
    return rm(path, { force: true }).then(
      () => true,
      () => false
    )
  })
}
