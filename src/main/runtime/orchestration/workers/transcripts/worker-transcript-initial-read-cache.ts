import { stat } from 'node:fs/promises'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'
import type { NativeChatLineDecoder } from '../../../../native-chat/transcript-tail-reader'

type Settled = { path: string; stamp: string; json: Buffer; charge: number }

/** One transcript file's current observed version, shared by its variants. A new version gets a
 *  new generation; work begun under an older one can finish for its caller but never publish. */
type Resource = { stamp: string | null; generation: object; refs: number }

type Active = { generation: object; token: object; promise: Promise<WorkerTranscriptReadResult> }

const MAX_SETTLED = 16
const MAX_SETTLED_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** Served first pages of transcripts nobody has written since, as their bounded serialized
 *  results: 16 entries, 512 KiB each, 8 MiB in all, only each file's current version. Reads in
 *  flight are owned separately, one per resource, variant and version, and shared by every caller
 *  asking for it; eviction never touches them, and only the current generation publishes. */
const settled = new Map<string, Settled>()
const active = new Map<string, Active>()
const resources = new Map<string, Resource>()
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
  const key = JSON.stringify([
    filePath,
    ...variant.map((part) => (typeof part === 'function' ? variantId(part) : part))
  ])
  const resource = retain(filePath)
  try {
    for (;;) {
      const observed = resource.generation
      const stamp = await versionStamp(filePath)
      // From here to the hit, join or start, nothing yields: a sample another observation
      // overtook is retaken, and a fresh one is admitted under the generation it produced.
      if (resource.generation !== observed) {
        continue
      }
      if (!stamp) {
        return await read()
      }
      adopt(filePath, resource, stamp)
      const admitted = admit(key, filePath, stamp, resource, read)
      admissionObserver?.(admitted.kind)
      return await admitted.result
    }
  } finally {
    release(filePath, resource)
  }
}

type Admission = { kind: 'hit' | 'join' | 'start'; result: Promise<WorkerTranscriptReadResult> }

/** Synchronous: a settled hit, the exact operation in flight, or new owned work. */
function admit(
  key: string,
  filePath: string,
  stamp: string,
  resource: Resource,
  read: () => Promise<WorkerTranscriptReadResult>
): Admission {
  const hit = settled.get(key)
  if (hit?.stamp === stamp) {
    settled.delete(key)
    settled.set(key, hit)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only successful read results are serialized into the cache.
    const result = JSON.parse(hit.json.toString('utf8')) as WorkerTranscriptReadResult
    return { kind: 'hit', result: Promise.resolve(result) }
  }
  const operation = `${key}\0${stamp}`
  const running = active.get(operation)
  if (running?.generation === resource.generation) {
    return { kind: 'join', result: running.promise }
  }
  const generation = resource.generation
  const token = {}
  const owned: Active = {
    generation,
    token,
    promise: (async () => {
      const result = await read()
      const after = await versionStamp(filePath)
      // Ownership and publication with no await between: an older generation never publishes.
      if (resource.generation !== generation || active.get(operation)?.token !== token) {
        return result
      }
      if (result.ok && after === stamp) {
        settle(key, filePath, stamp, result)
      } else if (after) {
        adopt(filePath, resource, after)
      }
      return result
    })()
  }
  active.set(operation, owned)
  const result = owned.promise.finally(() => {
    if (active.get(operation) === owned) {
      active.delete(operation)
    }
  })
  return { kind: 'start', result }
}

/** A newly observed version: a new generation, and the path's settled variants retire. The
 *  version already current changes nothing. */
function adopt(path: string, resource: Resource, stamp: string): void {
  if (resource.stamp === stamp) {
    return
  }
  resource.stamp = stamp
  resource.generation = {}
  for (const [key, entry] of settled) {
    if (entry.path === path) {
      drop(key)
    }
  }
}

function settle(
  key: string,
  path: string,
  stamp: string,
  result: WorkerTranscriptReadResult
): void {
  drop(key)
  const json = Buffer.from(JSON.stringify(result), 'utf8')
  const charge = json.length + Buffer.byteLength(key) + Buffer.byteLength(stamp)
  if (charge > MAX_SETTLED_BYTES) {
    return
  }
  settled.set(key, { path, stamp, json, charge })
  settledBytes += charge
  retain(path)
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
    const resource = resources.get(entry.path)
    if (resource) {
      release(entry.path, resource)
    }
  }
}

/** Resource records live while a read or settled variant refers to them, never longer. */
function retain(path: string): Resource {
  let resource = resources.get(path)
  if (!resource) {
    resource = { stamp: null, generation: {}, refs: 0 }
    resources.set(path, resource)
  }
  resource.refs++
  return resource
}

function release(path: string, resource: Resource): void {
  resource.refs--
  if (resource.refs <= 0 && resources.get(path) === resource) {
    resources.delete(path)
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

let admissionObserver: ((kind: Admission['kind']) => void) | undefined

/** Test seam: told each admission's decision as it is made. */
export function observeTranscriptAdmissions(
  observer: ((kind: Admission['kind']) => void) | undefined
): void {
  admissionObserver = observer
}

/** Test seam: the settled cache's footprint, how many entries one file holds, and how many
 *  resource records are alive. */
export function settledTranscriptPages(path?: string): {
  entries: number
  bytes: number
  resources: number
} {
  return {
    entries: path
      ? [...settled.values()].filter((entry) => entry.path === path).length
      : settled.size,
    bytes: settledBytes,
    resources: resources.size
  }
}
