// Separate snapshots avoid rewriting all app state per scan; a lost snapshot only costs a rescan.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from './durable-file-write'

const queues = new Map<string, Promise<unknown>>()
const staleTempCleanups = new Map<string, Promise<void>>()
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export function sidecarSnapshotFile(snapshotDirectory: string, fileName: string): string {
  return join(snapshotDirectory, fileName)
}

/** Serialize tasks per sidecar so read-modify-write patch/prune cycles cannot interleave. */
export function withSidecarSnapshotQueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve()
  const run = previous.then(task, task)
  const queued = run.then(
    () => undefined,
    () => undefined
  )
  queues.set(file, queued)
  void queued.then(() => {
    if (queues.get(file) === queued) {
      queues.delete(file)
    }
  })
  return run
}

export async function readSidecarSnapshot(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown
  } catch {
    return null
  }
}

export async function writeSidecarSnapshot(file: string, payload: unknown): Promise<void> {
  let cleanup = staleTempCleanups.get(file)
  if (!cleanup) {
    cleanup = removeStaleDurableWriteTempFiles(file, { minimumAgeMs: STALE_TEMP_AGE_MS })
    staleTempCleanups.set(file, cleanup)
    void cleanup.then(() => {
      if (staleTempCleanups.get(file) === cleanup) {
        staleTempCleanups.delete(file)
      }
    })
  }
  await cleanup
  await writeFileDurable(durableWriteTempPath(file), file, JSON.stringify(payload))
}

export function _getSidecarSnapshotPendingFileCountForTests(): number {
  return queues.size + staleTempCleanups.size
}
