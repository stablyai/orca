// Client-side cache of what an Orca Cloud workspace shows (chat transcripts, terminal output, git
// state), so a sleeping VM is browsable instantly without waking it. Conductor keeps chats on its
// servers; Orca keeps them on the VM (end-to-end encrypted), so the only copy outside the VM is
// this one, on the user's own disk. Bounded per workspace and in total; one file per environment.
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

export type OfflineCacheLimits = {
  /** Larger answers are not kept (one huge diff must not evict a workspace's chats). */
  maxEntryBytes: number
  maxEnvironmentBytes: number
  maxTotalBytes: number
  maxEntriesPerEnvironment: number
}

export const DEFAULT_OFFLINE_CACHE_LIMITS: OfflineCacheLimits = {
  maxEntryBytes: 1_500_000,
  maxEnvironmentBytes: 12_000_000,
  maxTotalBytes: 96_000_000,
  maxEntriesPerEnvironment: 400
}

export type OfflineCacheEntry = {
  method: string
  params: unknown
  result: unknown
  runtimeId: string
  at: number
  bytes: number
}

type EnvironmentFile = {
  version: 1
  environmentId: string
  updatedAt: number
  entries: Record<string, OfflineCacheEntry>
}

export type CloudOfflineCache = {
  record(
    environmentId: string,
    method: string,
    params: unknown,
    response: RuntimeRpcSuccess<unknown>
  ): void
  /** The cached answer marked with when it was captured, or null. */
  lookup(environmentId: string, method: string, params: unknown): OfflineCacheEntry | null
  entries(environmentId: string, method?: string): OfflineCacheEntry[]
  forget(environmentId: string): void
  /** Drop every environment not in `keep` (removed workspaces). */
  prune(keep: ReadonlySet<string>): void
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
  return `${createHash('sha256').update(environmentId).digest('hex').slice(0, 32)}.json`
}

export function createCloudOfflineCache(options: {
  root: string
  limits?: Partial<OfflineCacheLimits>
  now?: () => number
  /** Write delay; 0 writes synchronously (tests). */
  flushDelayMs?: number
}): CloudOfflineCache {
  const limits = { ...DEFAULT_OFFLINE_CACHE_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const flushDelayMs = options.flushDelayMs ?? 1_000
  const loaded = new Map<string, EnvironmentFile>()
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const pathOf = (environmentId: string) => join(options.root, fileName(environmentId))

  function load(environmentId: string): EnvironmentFile {
    const hit = loaded.get(environmentId)
    if (hit) {
      return hit
    }
    let file: EnvironmentFile = { version: 1, environmentId, updatedAt: 0, entries: {} }
    try {
      const parsed = JSON.parse(readFileSync(pathOf(environmentId), 'utf8')) as EnvironmentFile
      if (parsed.version === 1 && parsed.environmentId === environmentId && parsed.entries) {
        file = parsed
      }
    } catch {
      // Missing or unreadable: start empty. A cache is never a source of truth.
    }
    loaded.set(environmentId, file)
    return file
  }

  function sizeOf(file: EnvironmentFile): number {
    return Object.values(file.entries).reduce((total, entry) => total + entry.bytes, 0)
  }

  function evictWithin(file: EnvironmentFile): void {
    const byAge = Object.entries(file.entries).sort(([, a], [, b]) => a.at - b.at)
    let size = sizeOf(file)
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

  function write(environmentId: string): void {
    const file = loaded.get(environmentId)
    if (!file) {
      return
    }
    mkdirSync(options.root, { recursive: true, mode: 0o700 })
    const target = pathOf(environmentId)
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(file), { mode: 0o600 })
    renameSync(temp, target)
  }

  /** Whole environments go least-recently-updated first once the total passes its bound. */
  function evictTotal(): void {
    let files: { name: string; size: number; mtime: number }[]
    try {
      files = readdirSync(options.root)
        .filter((name) => name.endsWith('.json'))
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
      for (const [environmentId] of loaded) {
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
      const serialized = JSON.stringify(response.result ?? null)
      const bytes = serialized.length + JSON.stringify(params ?? null).length
      const file = load(environmentId)
      const key = stableKey(method, params)
      if (bytes > limits.maxEntryBytes) {
        // Too big to keep; don't serve an older, smaller answer as if it were current either.
        if (file.entries[key]) {
          delete file.entries[key]
          markDirty(environmentId)
        }
        return
      }
      file.entries[key] = {
        method,
        params: params ?? null,
        result: JSON.parse(serialized) as unknown,
        runtimeId: response._meta.runtimeId,
        at: now(),
        bytes
      }
      file.updatedAt = now()
      evictWithin(file)
      markDirty(environmentId)
    },
    lookup(environmentId, method, params) {
      if (!OFFLINE_READ_METHODS.has(method)) {
        return null
      }
      return load(environmentId).entries[stableKey(method, params)] ?? null
    },
    entries(environmentId, method) {
      return Object.values(load(environmentId).entries)
        .filter((entry) => method === undefined || entry.method === method)
        .sort((a, b) => b.at - a.at)
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
        if (name.endsWith('.json') && !keepFiles.has(name)) {
          rmSync(join(options.root, name), { force: true })
        }
      }
      for (const environmentId of loaded.keys()) {
        if (!keep.has(environmentId)) {
          loaded.delete(environmentId)
        }
      }
    },
    flush
  }
}
