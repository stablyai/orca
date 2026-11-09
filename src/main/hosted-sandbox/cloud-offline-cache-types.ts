// Types, limits and small helpers of the Orca Cloud offline cache (see cloud-offline-cache.ts).
import { readdirSync, rmSync } from 'node:fs'
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
export type StoredEntry = Omit<OfflineCacheEntry, 'result'> & { resultJson: string }

export type EnvironmentFile = {
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

export function removeLegacyPlaintextFiles(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      if (name.endsWith('.json')) {
        rmSync(join(root, name), { force: true })
      }
    }
  } catch {
    // No cache directory yet.
  }
}
