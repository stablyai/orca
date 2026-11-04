import {
  AI_VAULT_AGENTS,
  type AiVaultScanIssue,
  type AiVaultScope,
  type AiVaultSession
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { filterAiVaultSessions } from '../../../src/shared/ai-vault/session-display/ai-vault-session-filters'
import type { AgentSessionConversationNames } from '../../../src/shared/agent-session/agent-session-conversation-names'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import {
  deriveMobileAiVaultScopePaths,
  mobileAiVaultScanScopePaths,
  resolveActiveHistoryWorktree
} from './agent-history-scope-paths'
import { agentHistorySessionScan } from './mobile-agent-history-operations'

// Match desktop SESSION_LIMIT=500 for recency only; host separately caps in-scope union.
export const MOBILE_AI_VAULT_SESSION_LIMIT = 500
// Fast unscoped preview limit so cold opens paint the first screen (~6-8 visible rows) before a full 500-row scope walk.
export const MOBILE_AI_VAULT_FIRST_SCREEN_LIMIT = 24

/** Module cache cap. A phone keeps a handful of hosts and scopes, not the full desktop history. */
const MAX_CACHED_SNAPSHOTS = 20
const IS_VITEST = typeof process !== 'undefined' && Boolean(process.env?.VITEST)

const snapshotCache = new Map<string, AgentHistoryCachedSnapshot>()
const inflightPrewarms = new Set<string>()

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      sessions: AiVaultSession[]
      issues: AiVaultScanIssue[]
    }

export type FetchedHistoryState =
  | Exclude<AgentHistoryScreenState, { kind: 'ready' }>
  | (Extract<AgentHistoryScreenState, { kind: 'ready' }> & { hostId: string; client: RpcClient })

export type AgentHistoryCachedSnapshot = {
  fingerprint: string
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  client?: RpcClient | null
}

export type ScanMobileAgentSessionsParams = {
  scopePaths: string[] | undefined
  force: boolean
  limit?: number
  previous?: AgentHistoryCachedSnapshot | null
  /** Shown when the host refuses the scan with an empty message. */
  fallbackErrorMessage?: string
}

export type ScanMobileAgentSessionsResult = {
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  fingerprint?: string
}

/**
 * Returns the last scan for this host and scope, if the module cache still holds it.
 * A hit counts as use so a visible scope is not the first entry evicted.
 */
export function readCachedAgentHistorySnapshot(
  hostId: string,
  cacheKey: string
): AgentHistoryCachedSnapshot | undefined {
  const key = snapshotCacheId(hostId, cacheKey)
  const snapshot = snapshotCache.get(key)
  if (!snapshot) {
    return undefined
  }
  rememberAgentHistorySnapshot(key, snapshot)
  return snapshot
}

/** Returns the most recently used snapshot for this host and client so warm mounts render before worktree.ps resolves. */
export function readLatestCachedAgentHistorySnapshot(
  hostId: string,
  client: RpcClient | null
): AgentHistoryCachedSnapshot | undefined {
  if (!client) {
    return undefined
  }
  const prefix = `${hostId}\0`
  let latest: AgentHistoryCachedSnapshot | undefined
  for (const [key, snapshot] of snapshotCache) {
    if (key.startsWith(prefix) && snapshot.client === client) {
      latest = snapshot
    }
  }
  return latest
}

/** Seeds initial screen state from the warm host/client snapshot cache when connected. */
export function readInitialAgentHistoryScreenState(
  hostId: string,
  client: RpcClient | null,
  connState: ConnectionState
): FetchedHistoryState {
  if (connState === 'connected' && client) {
    const warm = readLatestCachedAgentHistorySnapshot(hostId, client)
    if (warm) {
      return {
        kind: 'ready',
        hostId,
        client,
        sessions: warm.sessions,
        issues: warm.issues
      }
    }
  }
  return { kind: 'loading' }
}

/** Applies live structured-session conversation names onto a ready screen state. */
export function applyAgentSessionConversationNames(
  screenState: FetchedHistoryState,
  names: AgentSessionConversationNames,
  hostId: string,
  client: RpcClient | null
): AgentHistoryScreenState {
  if (screenState.kind !== 'ready') {
    return screenState
  }
  const current = screenState.hostId === hostId && screenState.client === client
  return {
    kind: 'ready',
    issues: screenState.issues,
    sessions: current
      ? screenState.sessions.map((session) => {
          const id = session.structuredSession?.sessionId
          const title = id ? names.get(id)?.conversationName : null
          return title ? { ...session, title } : session
        })
      : screenState.sessions
  }
}

/** Fetches a small unscoped preview on cold open and returns a ready state when it has visible matches for the current scope. */
export async function scanMobileAgentFirstScreenPreview(
  client: RpcClient,
  options: {
    hostId: string
    scope: AiVaultScope
    derivedScopePaths: string[]
    fallbackErrorMessage: string
  }
): Promise<FetchedHistoryState | null> {
  const preview = await scanMobileAgentSessions(client, {
    scopePaths: undefined,
    limit: MOBILE_AI_VAULT_FIRST_SCREEN_LIMIT,
    force: false,
    fallbackErrorMessage: options.fallbackErrorMessage
  })
  const narrowPreview = options.scope !== 'all' && options.derivedScopePaths.length > 0
  const matchingPreview = filterAiVaultSessions(preview.sessions, {
    query: '',
    agents: AI_VAULT_AGENTS,
    scope: narrowPreview ? 'workspace' : 'all',
    sort: 'updated',
    activeWorktreePaths: narrowPreview ? options.derivedScopePaths : [],
    hideEmptySessions: true
  })
  if (matchingPreview.length === 0 && (options.scope !== 'all' || preview.sessions.length === 0)) {
    return null
  }
  return {
    kind: 'ready',
    hostId: options.hostId,
    client,
    sessions: preview.sessions,
    issues: preview.issues
  }
}

/** Stores a scan snapshot, dropping the least recently used entry past the cap. */
export function writeCachedAgentHistorySnapshot(
  hostId: string,
  cacheKey: string,
  snapshot: AgentHistoryCachedSnapshot
): void {
  rememberAgentHistorySnapshot(snapshotCacheId(hostId, cacheKey), snapshot)
}

/** Drops every cached scan so a host switch or test cannot reuse another machine's rows. */
export function clearCachedAgentHistorySnapshots(): void {
  snapshotCache.clear()
  inflightPrewarms.clear()
}

/** Prewarms the scoped snapshot cache in the background so cold navigation into Agent Session History renders on frame 0. */
export function prewarmMobileAgentHistorySnapshot(
  hostId: string,
  worktreeId: string,
  client: RpcClient | null,
  enabled = !IS_VITEST
): void {
  if (!client || !enabled) {
    return
  }
  const activeWorktree = resolveActiveHistoryWorktree([], worktreeId, true)
  const scopePaths = mobileAiVaultScanScopePaths(
    deriveMobileAiVaultScopePaths('workspace', activeWorktree, [])
  )
  const cacheKey = scopePaths.join('\0')
  if (readCachedAgentHistorySnapshot(hostId, cacheKey)) {
    return
  }
  const inflightKey = snapshotCacheId(hostId, cacheKey)
  if (inflightPrewarms.has(inflightKey)) {
    return
  }
  inflightPrewarms.add(inflightKey)
  void scanMobileAgentSessions(client, {
    scopePaths,
    force: false
  })
    .then((result) => {
      if (result.fingerprint) {
        writeCachedAgentHistorySnapshot(hostId, cacheKey, {
          fingerprint: result.fingerprint,
          sessions: result.sessions,
          issues: result.issues,
          client
        })
      }
    })
    .catch(() => {})
    .finally(() => {
      inflightPrewarms.delete(inflightKey)
    })
}

/**
 * Lists agent sessions for the scope. `afterFingerprint` is always sent: `null` asks for a full
 * scan, and a previous fingerprint lets the host return `unchanged` instead of the row set.
 */
export async function scanMobileAgentSessions(
  client: RpcClient,
  params: ScanMobileAgentSessionsParams
): Promise<ScanMobileAgentSessionsResult> {
  const limit = params.limit ?? MOBILE_AI_VAULT_SESSION_LIMIT
  const fallbackErrorMessage = params.fallbackErrorMessage ?? 'Unable to load agent sessions'
  const previousFingerprint = !params.force ? (params.previous?.fingerprint ?? null) : null
  const reply = await agentHistorySessionScan.request(client, {
    limit,
    force: params.force,
    scopePaths: params.scopePaths,
    afterFingerprint: previousFingerprint
  })

  const result = interpretOrThrowRefusalMessage(
    () => agentHistorySessionScan.interpret(reply),
    fallbackErrorMessage
  )
  if (result.unchanged === true) {
    if (params.previous && result.fingerprint === params.previous.fingerprint) {
      return {
        sessions: params.previous.sessions,
        issues: params.previous.issues,
        fingerprint: result.fingerprint
      }
    }
    // Fall back to a full scan if the client lacks the matching previous snapshot.
    const fallbackReply = await agentHistorySessionScan.request(client, {
      limit,
      force: true,
      scopePaths: params.scopePaths,
      afterFingerprint: null
    })
    const fallbackResult = interpretOrThrowRefusalMessage(
      () => agentHistorySessionScan.interpret(fallbackReply),
      fallbackErrorMessage
    )
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque session records
      sessions: fallbackResult.sessions as AiVaultSession[],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque issue records
      issues: fallbackResult.issues as AiVaultScanIssue[],
      fingerprint: fallbackResult.fingerprint
    }
  }

  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque session records
    sessions: result.sessions as AiVaultSession[],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque issue records
    issues: result.issues as AiVaultScanIssue[],
    fingerprint: result.fingerprint
  }
}

/** One slot per host and scope. The separator keeps those two fields from aliasing each other. */
function snapshotCacheId(hostId: string, cacheKey: string): string {
  return `${hostId}\0${cacheKey}`
}

/** Puts this snapshot last in insertion order, which is the newest end of the LRU. */
function rememberAgentHistorySnapshot(key: string, snapshot: AgentHistoryCachedSnapshot): void {
  snapshotCache.delete(key)
  snapshotCache.set(key, snapshot)
  if (snapshotCache.size <= MAX_CACHED_SNAPSHOTS) {
    return
  }
  const oldest = snapshotCache.keys().next().value
  if (oldest !== undefined) {
    snapshotCache.delete(oldest)
  }
}
