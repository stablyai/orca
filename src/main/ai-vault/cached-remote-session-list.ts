import type { AiVaultListResult } from '../../shared/ai-vault-types'
import {
  CURSOR_SIDECAR_SCAN_VERSION,
  cursorRemoteScopePathsWereTruncated,
  normalizeCursorRemoteScopePaths
} from '../../shared/cursor-sidecar-scan'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { IFilesystemProvider } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'

const REMOTE_AI_VAULT_CACHE_TTL_MS = 15_000
export const REMOTE_AI_VAULT_CACHE_MAX_KEYS_PER_PROVIDER = 8

type CacheEntry = {
  result?: AiVaultListResult
  expiresAt: number
  inflight?: Promise<AiVaultListResult>
  lastUsedAt: number
}

let cacheByProvider = new WeakMap<IFilesystemProvider, Map<string, CacheEntry>>()

export async function listCachedRemoteAiVaultSessions(args: {
  provider: IFilesystemProvider
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
  limit?: number
  scopePaths?: readonly string[]
  force?: boolean
  signal?: AbortSignal
}): Promise<AiVaultListResult> {
  const effectiveScopePaths = normalizeCursorRemoteScopePaths(
    args.scopePaths ?? [],
    args.hostPlatform.os
  )
  const scopePathsTruncated = cursorRemoteScopePathsWereTruncated(
    args.scopePaths ?? [],
    args.hostPlatform.os
  )
  const providerCache = providerEntries(args.provider)
  const key = remoteRequestKey({ ...args, scopePaths: effectiveScopePaths })
  const existing = providerCache.get(key)
  const now = Date.now()
  if (existing?.inflight) {
    existing.lastUsedAt = now
    try {
      return withScopePathTruncationIssue(await existing.inflight, args, scopePathsTruncated)
    } catch (error) {
      // The shared scan carries the initiating caller's abort semantics; re-issue our own
      // scan rather than inheriting an abort this caller never requested.
      if (args.signal?.aborted !== false) {
        throw error
      }
    }
  }
  if (args.force !== true && existing?.result && existing.expiresAt > now) {
    existing.lastUsedAt = now
    return withScopePathTruncationIssue(existing.result, args, scopePathsTruncated)
  }

  const entry: CacheEntry = existing ?? { expiresAt: 0, lastUsedAt: now }
  entry.lastUsedAt = now
  const inflight = scanRemoteAiVaultSessions({
    provider: args.provider,
    executionHostId: args.executionHostId,
    remoteHome: args.remoteHome,
    hostPlatform: args.hostPlatform,
    limit: args.limit,
    scopePaths: effectiveScopePaths,
    signal: args.signal
  })
    .then((result) => {
      entry.result = result
      entry.expiresAt = Date.now() + REMOTE_AI_VAULT_CACHE_TTL_MS
      return result
    })
    .finally(() => {
      if (entry.inflight === inflight) {
        entry.inflight = undefined
      }
    })
  entry.inflight = inflight
  providerCache.delete(key)
  providerCache.set(key, entry)
  evictRemoteCacheKeys(providerCache, key)
  return withScopePathTruncationIssue(await inflight, args, scopePathsTruncated)
}

export function resetCachedRemoteAiVaultSessionsForTests(): void {
  cacheByProvider = new WeakMap()
}

function providerEntries(provider: IFilesystemProvider): Map<string, CacheEntry> {
  const existing = cacheByProvider.get(provider)
  if (existing) {
    return existing
  }
  const created = new Map<string, CacheEntry>()
  cacheByProvider.set(provider, created)
  return created
}

function remoteRequestKey(args: {
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
  limit?: number
  scopePaths?: readonly string[]
}): string {
  const scopePaths = [
    ...new Set((args.scopePaths ?? []).map((path) => path.trim()).filter(Boolean))
  ].sort()
  return JSON.stringify({
    executionHostId: args.executionHostId,
    remoteHome: args.remoteHome,
    hostPlatform: args.hostPlatform,
    limit: args.limit ?? 'default',
    protocolVersion: CURSOR_SIDECAR_SCAN_VERSION,
    scopePaths
  })
}

function evictRemoteCacheKeys(entries: Map<string, CacheEntry>, activeKey: string): void {
  while (entries.size > REMOTE_AI_VAULT_CACHE_MAX_KEYS_PER_PROVIDER) {
    const candidate = [...entries.entries()]
      .filter(([key, entry]) => key !== activeKey && !entry.inflight)
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0]
    if (!candidate) {
      return
    }
    entries.delete(candidate[0])
  }
}

function withScopePathTruncationIssue(
  result: AiVaultListResult,
  args: {
    executionHostId: ExecutionHostId
    remoteHome: string
    hostPlatform: RemoteHostPlatform
  },
  truncated: boolean
): AiVaultListResult {
  if (!truncated) {
    return result
  }
  return {
    ...result,
    issues: [
      ...result.issues,
      {
        executionHostId: args.executionHostId,
        agent: 'cursor',
        path: joinRemotePath(args.hostPlatform, args.remoteHome, '.cursor', 'chats'),
        message: 'Cursor sidecar scan truncated by the scope paths limit.'
      }
    ]
  }
}
