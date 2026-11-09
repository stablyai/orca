// Client-side cache of what an Orca Cloud workspace shows (chat transcripts, terminal output, git
// state), so a sleeping VM is browsable instantly without waking it. Conductor keeps chats on its
// servers; Orca keeps them on the VM (end-to-end encrypted), so the only copy outside the VM is
// this one, on the user's own disk, sealed with the OS keychain. Without a keychain nothing is kept.
// Bounded per workspace, in total, and in memory; one file per environment.
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'

/** Read-only methods whose answers stay meaningful while the VM sleeps. Nothing that mutates. */
export const OFFLINE_READ_METHODS: ReadonlySet<string> = new Set([
  'agentSession.history',
  'agentSession.conversationOutline',
  'agentSession.item',
  'terminal.list',
  'terminal.read',
  'session.readTerminalScrollback',
  'git.status',
  'git.history',
  'git.upstreamStatus',
  'git.localBranches',
  'git.branchCompare',
  'worktree.show',
  'github.prForBranch',
  'github.prChecks',
  'github.prComments',
  'hostedReview.forBranch'
])

/** Seals files at rest (Electron safeStorage in the app). */
export type OfflineCacheCodec = {
  encrypt(plain: string): Buffer
  decrypt(sealed: Buffer): string
}

export type OfflineCacheLimits = {
  /** Larger answers are not kept (one huge diff must not evict a workspace's chats). */
  maxEntryBytes: number
  maxEnvironmentBytes: number
  maxTotalBytes: number
  maxEntriesPerEnvironment: number
  /** Environments held decoded in memory at once (least recently used are dropped). */
  maxLoadedEnvironments: number
  /** A key answered again within this window is not re-serialized (terminal polling). */
  minRecordIntervalMs: number
}

export const DEFAULT_OFFLINE_CACHE_LIMITS: OfflineCacheLimits = {
  maxEntryBytes: 1_500_000,
  maxEnvironmentBytes: 12_000_000,
  maxTotalBytes: 96_000_000,
  maxEntriesPerEnvironment: 400,
  maxLoadedEnvironments: 8,
  minRecordIntervalMs: 5_000
}

export type OfflineCacheEntry = {
  method: string
  params: unknown
  result: unknown
  runtimeId: string
  at: number
  bytes: number
}

/** On disk and in memory the answer stays serialized; it is parsed only when read. */
type StoredEntry = Omit<OfflineCacheEntry, 'result'> & { resultJson: string }

type EnvironmentFile = {
  version: 2
  environmentId: string
  updatedAt: number
  entries: Record<string, StoredEntry>
}

export type CloudOfflineCache = {
  record(
    environmentId: string,
    method: string,
    params: unknown,
    response: RuntimeRpcSuccess<unknown>
  ): void
  lookup(environmentId: string, method: string, params: unknown): OfflineCacheEntry | null
  entries(environmentId: string, method?: string): OfflineCacheEntry[]
  forget(environmentId: string): void
  /** Drop every environment not in `keep` (removed workspaces). */
  prune(keep: ReadonlySet<string>): void
  /** Delete everything (sign-out, profile switch). */
  clear(): void
  flush(): void
}

/** Key-order independent, so `{a,b}` and `{b,a}` hit the same entry. */
export function stableKey(method: string, params: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sort)
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, sort((value as Record<string, unknown>)[key])])
      )
    }
    return value
  }
  return `${method} ${JSON.stringify(sort(params ?? null))}`
}

function fileName(environmentId: string): string {
  return `${createHash('sha256').update(environmentId).digest('hex').slice(0, 32)}.bin`
}

function decode(entry: StoredEntry): OfflineCacheEntry {
  const { resultJson, ...rest } = entry
  return { ...rest, result: JSON.parse(resultJson) as unknown }
}

const DISABLED: CloudOfflineCache = {
  record: () => {},
  lookup: () => null,
  entries: () => [],
  forget: () => {},
  prune: () => {},
  clear: () => {},
  flush: () => {}
}

export function createCloudOfflineCache(options: {
  root: string
  /** Null: the OS cannot seal files, so nothing is cached. */
  codec: OfflineCacheCodec | null
  limits?: Partial<OfflineCacheLimits>
  now?: () => number
  /** Write delay; 0 writes synchronously (tests). */
  flushDelayMs?: number
}): CloudOfflineCache {
  const codec = options.codec
  if (!codec) {
    return DISABLED
  }
  const limits = { ...DEFAULT_OFFLINE_CACHE_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const flushDelayMs = options.flushDelayMs ?? 1_000
  // Map insertion order is the LRU order: a touched environment is re-inserted at the end.
  const loaded = new Map<string, EnvironmentFile>()
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const pathOf = (environmentId: string) => join(options.root, fileName(environmentId))

  function write(environmentId: string): void {
    const file = loaded.get(environmentId)
    if (!file) {
      return
    }
    mkdirSync(options.root, { recursive: true, mode: 0o700 })
    const target = pathOf(environmentId)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, codec!.encrypt(JSON.stringify(file)), { mode: 0o600 })
    renameSync(temp, target)
  }

  function load(environmentId: string): EnvironmentFile {
    const hit = loaded.get(environmentId)
    if (hit) {
      loaded.delete(environmentId)
      loaded.set(environmentId, hit)
      return hit
    }
    let file: EnvironmentFile = { version: 2, environmentId, updatedAt: 0, entries: {} }
    try {
      const parsed = JSON.parse(
        codec!.decrypt(readFileSync(pathOf(environmentId)))
      ) as EnvironmentFile
      if (parsed.version === 2 && parsed.environmentId === environmentId && parsed.entries) {
        file = parsed
      }
    } catch {
      // Missing, unreadable or sealed by another keychain: start empty. A cache is never a source of truth.
    }
    loaded.set(environmentId, file)
    while (loaded.size > limits.maxLoadedEnvironments) {
      const oldest = loaded.keys().next().value!
      if (dirty.has(oldest)) {
        write(oldest)
        dirty.delete(oldest)
      }
      loaded.delete(oldest)
    }
    return file
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
  function evictTotal(): void {
    let files: { name: string; size: number; mtime: number }[]
    try {
      files = readdirSync(options.root)
        .filter((name) => name.endsWith('.bin'))
        .map((name) => {
          const stat = statSync(join(options.root, name))
          return { name, size: stat.size, mtime: stat.mtimeMs }
        })
    } catch {
      return
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= limits.maxTotalBytes) {
        break
      }
      rmSync(join(options.root, file.name), { force: true })
      for (const environmentId of loaded.keys()) {
        if (fileName(environmentId) === file.name) {
          loaded.delete(environmentId)
        }
      }
      total -= file.size
    }
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    for (const environmentId of dirty) {
      try {
        write(environmentId)
      } catch (error) {
        console.error(`[orca-cloud] offline cache write failed: ${String(error)}`)
      }
    }
    dirty.clear()
    evictTotal()
  }

  function markDirty(environmentId: string): void {
    dirty.add(environmentId)
    if (flushDelayMs === 0) {
      flush()
      return
    }
    if (!timer) {
      timer = setTimeout(flush, flushDelayMs)
      timer.unref?.()
    }
  }

  return {
    record(environmentId, method, params, response) {
      if (!OFFLINE_READ_METHODS.has(method)) {
        return
      }
      const file = load(environmentId)
      const key = stableKey(method, params)
      const existing = file.entries[key]
      const at = now()
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
    },
    lookup(environmentId, method, params) {
      if (!OFFLINE_READ_METHODS.has(method)) {
        return null
      }
      const entry = load(environmentId).entries[stableKey(method, params)]
      return entry ? decode(entry) : null
    },
    entries(environmentId, method) {
      return Object.values(load(environmentId).entries)
        .filter((entry) => method === undefined || entry.method === method)
        .sort((a, b) => b.at - a.at)
        .map(decode)
    },
    forget(environmentId) {
      loaded.delete(environmentId)
      dirty.delete(environmentId)
      rmSync(pathOf(environmentId), { force: true })
    },
    prune(keep) {
      const keepFiles = new Set([...keep].map(fileName))
      let names: string[] = []
      try {
        names = readdirSync(options.root)
      } catch {
        return
      }
      for (const name of names) {
        if (!keepFiles.has(name)) {
          rmSync(join(options.root, name), { force: true })
        }
      }
      for (const environmentId of loaded.keys()) {
        if (!keep.has(environmentId)) {
          loaded.delete(environmentId)
          dirty.delete(environmentId)
        }
      }
    },
    clear() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      loaded.clear()
      dirty.clear()
      rmSync(options.root, { recursive: true, force: true })
    },
    flush
  }
}
