// Why a sidecar next to orca-data.json: scan snapshots rewrite wholesale and can reach hundreds
// of KB; folding them into orca-data.json would rewrite the whole state file per scan (the
// githubCache sidecar precedent). Best-effort by design: a lost snapshot only costs a rescan.
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
  queues.set(
    file,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** Parsed sidecar contents, or null when the file is missing or not valid JSON. */
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
  }
  await cleanup
  await writeFileDurable(durableWriteTempPath(file), file, JSON.stringify(payload))
}
