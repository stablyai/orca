// Client-side cache of what an Orca Cloud workspace shows (chat transcripts, terminal output, git
// state), so a sleeping VM is browsable instantly without waking it. Conductor keeps chats on its
// servers; Orca keeps them on the VM (end-to-end encrypted), so the only copy outside the VM is
// this one, on the user's own disk, sealed with the OS keychain. Without a keychain nothing is kept.
// Bounded per workspace, in total, and in memory; one file per environment.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  decode,
  DEFAULT_OFFLINE_CACHE_LIMITS,
  DISABLED_OFFLINE_CACHE,
  EnvironmentFileSchema,
  fileName,
  OFFLINE_READ_METHODS,
  removeLegacyPlaintextFiles,
  stableKey,
  type CloudOfflineCache,
  type EnvironmentFile,
  type OfflineCacheCodec,
  type OfflineCacheLimits
} from './cloud-offline-cache-types'

export {
  DEFAULT_OFFLINE_CACHE_LIMITS,
  OFFLINE_READ_METHODS,
  stableKey,
  type CloudOfflineCache,
  type OfflineCacheCodec,
  type OfflineCacheEntry,
  type OfflineCacheLimits
} from './cloud-offline-cache-types'

export function createCloudOfflineCache(options: {
  root: string
  /** Null: the OS cannot seal files, so nothing is cached. */
  codec: OfflineCacheCodec | null
  limits?: Partial<OfflineCacheLimits>
  now?: () => number
  /** Write delay; 0 writes as soon as a record lands (tests). */
  flushDelayMs?: number
}): CloudOfflineCache {
  // All file work runs one task at a time, in call order, off the main thread's sync fs path.
  let io: Promise<unknown> = Promise.resolve()
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = io.then(task, task)
    io = run.catch(() => undefined)
    return run
  }
  // Plaintext v1 files from the first build are never read; remove them whatever the codec.
  const legacyRemoved = serial(() => removeLegacyPlaintextFiles(options.root))
  const codec = options.codec
  if (!codec) {
    return { ...DISABLED_OFFLINE_CACHE, flush: () => legacyRemoved }
  }
  const limits = { ...DEFAULT_OFFLINE_CACHE_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const flushDelayMs = options.flushDelayMs ?? 1_000
  // Map insertion order is the LRU order: a touched environment is re-inserted at the end.
  const loaded = new Map<string, EnvironmentFile>()
  const loading = new Map<string, Promise<EnvironmentFile>>()
  const dirty = new Set<string>()
  // Bumped by forget/prune/clear so a read that started before them is not cached afterwards.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const pathOf = (environmentId: string) => join(options.root, fileName(environmentId))

  function write(file: EnvironmentFile): Promise<void> {
    const serialized = codec!.encrypt(JSON.stringify(file))
    return serial(async () => {
      await mkdir(options.root, { recursive: true, mode: 0o700 })
      const target = pathOf(file.environmentId)
      const temp = `${target}.${process.pid}.tmp`
      await writeFile(temp, serialized, { mode: 0o600 })
      await rename(temp, target)
    })
  }

  async function readFromDisk(environmentId: string): Promise<EnvironmentFile> {
    try {
      const parsed = EnvironmentFileSchema.safeParse(
        JSON.parse(codec!.decrypt(await readFile(pathOf(environmentId))))
      )
      if (parsed.success && parsed.data.environmentId === environmentId) {
        return parsed.data
      }
    } catch {
      // Missing, unreadable or sealed by another keychain: start empty. A cache is never a source of truth.
    }
    return { version: 2, environmentId, updatedAt: 0, entries: {} }
  }

  function load(environmentId: string): Promise<EnvironmentFile> {
    const hit = loaded.get(environmentId)
    if (hit) {
      loaded.delete(environmentId)
      loaded.set(environmentId, hit)
      return Promise.resolve(hit)
    }
    const pending = loading.get(environmentId)
    if (pending) {
      return pending
    }
    const startedAt = generation
    const reading = serial(() => readFromDisk(environmentId)).then((file) => {
      loading.delete(environmentId)
      const raced = loaded.get(environmentId)
      if (raced || startedAt !== generation) {
        return raced ?? file
      }
      loaded.set(environmentId, file)
      while (loaded.size > limits.maxLoadedEnvironments) {
        const oldest = loaded.keys().next().value!
        const evicted = loaded.get(oldest)
        if (evicted && dirty.has(oldest)) {
          dirty.delete(oldest)
          void write(evicted).catch(logWriteFailure)
        }
        loaded.delete(oldest)
      }
      return file
    })
    loading.set(environmentId, reading)
    return reading
  }

  function evictWithin(file: EnvironmentFile): void {
    const byAge = Object.entries(file.entries).sort(([, a], [, b]) => a.at - b.at)
    let size = byAge.reduce((total, [, entry]) => total + entry.bytes, 0)
    let count = byAge.length
    for (const [key, entry] of byAge) {
      if (size <= limits.maxEnvironmentBytes && count <= limits.maxEntriesPerEnvironment) {
        break
      }
      delete file.entries[key]
      size -= entry.bytes
      count--
    }
  }

  /** Whole environments go least-recently-written first once the total passes its bound. */
  async function evictTotal(): Promise<void> {
    let files: { name: string; size: number; mtime: number }[]
    try {
      const names = (await readdir(options.root)).filter((name) => name.endsWith('.bin'))
      files = await Promise.all(
        names.map(async (name) => {
          const info = await stat(join(options.root, name))
          return { name, size: info.size, mtime: info.mtimeMs }
        })
      )
    } catch {
      return
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= limits.maxTotalBytes) {
        break
      }
      await rm(join(options.root, file.name), { force: true })
      for (const environmentId of loaded.keys()) {
        if (fileName(environmentId) === file.name) {
          loaded.delete(environmentId)
        }
      }
      total -= file.size
    }
  }

  function logWriteFailure(error: unknown): void {
    console.error(`[orca-cloud] offline cache write failed: ${String(error)}`)
  }

  // Records apply after their environment loads; flush waits for those still landing.
  const applying = new Set<Promise<void>>()

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await Promise.all(applying)
    const files = [...dirty].flatMap((environmentId) => loaded.get(environmentId) ?? [])
    dirty.clear()
    await Promise.all(files.map((file) => write(file).catch(logWriteFailure)))
    await serial(evictTotal)
  }

  function markDirty(environmentId: string): void {
    dirty.add(environmentId)
    if (flushDelayMs === 0) {
      void flush()
      return
    }
    if (!timer) {
      timer = setTimeout(() => void flush(), flushDelayMs)
      timer.unref?.()
    }
  }

  return {
    record(environmentId, method, params, response) {
      if (!OFFLINE_READ_METHODS.has(method)) {
        return
      }
      const at = now()
      const applied = load(environmentId).then((file) => {
        const key = stableKey(method, params)
        const existing = file.entries[key]
        if (existing && at - existing.at < limits.minRecordIntervalMs) {
          return
        }
        const resultJson = JSON.stringify(response.result ?? null)
        const bytes = resultJson.length + key.length
        if (bytes > limits.maxEntryBytes) {
          // Too big to keep; don't serve an older, smaller answer as if it were current either.
          if (existing) {
            delete file.entries[key]
            markDirty(environmentId)
          }
          return
        }
        file.entries[key] = {
          method,
          params: params ?? null,
          resultJson,
          runtimeId: response._meta.runtimeId,
          at,
          bytes
        }
        file.updatedAt = at
        evictWithin(file)
        markDirty(environmentId)
      })
      applying.add(applied)
      void applied.finally(() => applying.delete(applied))
    },
    async lookup(environmentId, method, params) {
      if (!OFFLINE_READ_METHODS.has(method)) {
        return null
      }
      await Promise.all(applying)
      const entry = (await load(environmentId)).entries[stableKey(method, params)]
      return entry ? decode(entry) : null
    },
    async entries(environmentId, method) {
      await Promise.all(applying)
      return Object.values((await load(environmentId)).entries)
        .filter((entry) => method === undefined || entry.method === method)
        .sort((a, b) => b.at - a.at)
        .map(decode)
    },
    forget(environmentId) {
      generation++
      loaded.delete(environmentId)
      dirty.delete(environmentId)
      return serial(() => rm(pathOf(environmentId), { force: true }))
    },
    prune(keep) {
      generation++
      for (const environmentId of loaded.keys()) {
        if (!keep.has(environmentId)) {
          loaded.delete(environmentId)
          dirty.delete(environmentId)
        }
      }
      const keepFiles = new Set([...keep].map(fileName))
      return serial(async () => {
        const names = await readdir(options.root).catch(() => [])
        for (const name of names) {
          if (!keepFiles.has(name)) {
            await rm(join(options.root, name), { force: true })
          }
        }
      })
    },
    clear() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      generation++
      loaded.clear()
      dirty.clear()
      return serial(() => rm(options.root, { recursive: true, force: true }))
    },
    flush
  }
}
