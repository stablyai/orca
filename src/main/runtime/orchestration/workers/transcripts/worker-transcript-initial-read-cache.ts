import { stat } from 'node:fs/promises'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'
import type { NativeChatLineDecoder } from '../../../../native-chat/transcript-tail-reader'

type Settled = { path: string; stamp: string; json: Buffer; charge: number }

const MAX_SETTLED = 16
const MAX_SETTLED_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** Served first pages of transcripts nobody has written since, as their bounded serialized
 *  results: 16 entries, 512 KiB each, 8 MiB in all, only each file's current version. Reads in
 *  flight are owned separately, one per resource and version, and shared by every caller asking
 *  for it; eviction never touches them, and only a success whose file is unchanged settles. */
const settled = new Map<string, Settled>()
const active = new Map<string, Promise<WorkerTranscriptReadResult>>()
let settledBytes = 0

const variantIds = new WeakMap<NativeChatLineDecoder, number>()
let nextVariantId = 0

/** Device, inode, size and nanosecond mtime and ctime: a rewrite restoring size and mtime
 *  still moves ctime. Null when the file system gives no stable identity to stamp. */
async function versionStamp(filePath: string): Promise<string | null> {
  const stats = await stat(filePath, { bigint: true }).catch(() => null)
  if (!stats?.isFile() || (stats.dev === 0n && stats.ino === 0n)) {
    return null
  }
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
}

export async function readInitialWorkerTranscriptReusing(
  filePath: string,
  variant: readonly (number | string | NativeChatLineDecoder)[],
  read: () => Promise<WorkerTranscriptReadResult>
): Promise<WorkerTranscriptReadResult> {
  const stamp = await versionStamp(filePath)
  if (!stamp) {
    return read()
  }
  const key = JSON.stringify([
    filePath,
    ...variant.map((part) => (typeof part === 'function' ? variantId(part) : part))
  ])
  const hit = settled.get(key)
  if (hit?.stamp === stamp) {
    settled.delete(key)
    settled.set(key, hit)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only successful read results are serialized into the cache.
    return JSON.parse(hit.json.toString('utf8')) as WorkerTranscriptReadResult
  }
  const operation = `${key}\0${stamp}`
  const running = active.get(operation)
  if (running) {
    return running
  }
  const started = (async () => {
    const result = await read()
    // A scan that overlapped a write keeps its answer, but is never served as this version.
    if (result.ok && (await versionStamp(filePath)) === stamp) {
      settle(key, filePath, stamp, result)
    }
    return result
  })()
  active.set(operation, started)
  try {
    return await started
  } finally {
    if (active.get(operation) === started) {
      active.delete(operation)
    }
  }
}

function settle(
  key: string,
  path: string,
  stamp: string,
  result: WorkerTranscriptReadResult
): void {
  // The file is at this version now, so every other version of it is obsolete.
  for (const [other, entry] of settled) {
    if (entry.path === path && entry.stamp !== stamp) {
      drop(other)
    }
  }
  drop(key)
  const json = Buffer.from(JSON.stringify(result), 'utf8')
  const charge = json.length + Buffer.byteLength(key) + Buffer.byteLength(stamp)
  if (charge > MAX_SETTLED_BYTES) {
    return
  }
  settled.set(key, { path, stamp, json, charge })
  settledBytes += charge
  for (const [oldest] of settled) {
    if (settled.size <= MAX_SETTLED && settledBytes <= MAX_TOTAL_BYTES) {
      break
    }
    drop(oldest)
  }
}

function drop(key: string): void {
  const entry = settled.get(key)
  if (entry) {
    settled.delete(key)
    settledBytes -= entry.charge
  }
}

function variantId(part: NativeChatLineDecoder): number {
  let id = variantIds.get(part)
  if (id === undefined) {
    id = nextVariantId++
    variantIds.set(part, id)
  }
  return id
}

/** Test seam: the settled cache's footprint, and how many entries one file holds. */
export function settledTranscriptPages(path?: string): { entries: number; bytes: number } {
  return {
    entries: path
      ? [...settled.values()].filter((entry) => entry.path === path).length
      : settled.size,
    bytes: settledBytes
  }
}
