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

export type SidecarSnapshotReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'unreadable'; error: unknown }
  | { status: 'malformed'; error: unknown }

export async function readSidecarSnapshotResult(file: string): Promise<SidecarSnapshotReadResult> {
  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'missing' }
    }
    return { status: 'unreadable', error }
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as unknown }
  } catch (error) {
    return { status: 'malformed', error }
  }
}

export async function readSidecarSnapshot(file: string): Promise<unknown> {
  const result = await readSidecarSnapshotResult(file)
  return result.status === 'ok' ? result.value : null
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
