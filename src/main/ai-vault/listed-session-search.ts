import { app } from 'electron'
import { join } from 'node:path'
import type {
  AiVaultRankSessionsArgs,
  AiVaultRankSessionsResult
} from '../../shared/ai-vault-session-ai-query'
import {
  emptyAiVaultSearchSessionsResult,
  isAiVaultRgSearchScope,
  type AiVaultSearchSessionsArgs,
  type AiVaultSearchSessionsResult
} from '../../shared/ai-vault-session-search-scope'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import {
  matchListedSessionsByCardMetadata,
  partitionListedSearchSessions
} from './listed-session-remote-search'
import { rankAiVaultSessionsWithModel } from './session-ai-rerank'
import {
  getAiVaultSessionMessageFtsStore,
  type AiVaultMessageFtsSearchResult
} from './session-message-fts-store'
import { getAiVaultSessionFtsStore } from './session-search-store'
import { searchAiVaultSessionsWithRg } from './session-transcript-rg'

export type ListedSessionSearchOptions = {
  getSettings?: () => GlobalSettings
  getRepo?: (repoId: string) => Repo | undefined
  getWslDistroForRepo?: (repo: Repo) => string | undefined
}

// Why: rg search needs the last listed session paths; the renderer only sends ids.
let lastListedSessions: AiVaultSession[] = []

export function rememberListedAiVaultSessions(sessions: readonly AiVaultSession[]): void {
  lastListedSessions = [...sessions]
}

export function clearListedAiVaultSessions(): void {
  lastListedSessions = []
}

type ListedSessionMessageIndexQueue = {
  pending: readonly AiVaultSession[] | null
  inflight: Promise<void> | null
}

const listedSessionMessageIndexByPath = new Map<string, ListedSessionMessageIndexQueue>()

export function resetListedSessionMessageIndexQueue(): void {
  listedSessionMessageIndexByPath.clear()
}

export function syncDurableSessionIndex(result: AiVaultListResult): void {
  try {
    getAiVaultSessionFtsStore(join(app.getPath('userData'), 'ai-vault-session-fts.sqlite')).sync(
      result.sessions
    )
    // Why: message-index path also needs userData. Keep it inside this try so a
    // missing Electron app path cannot turn a successful host scan into an issue.
    void indexListedSessionMessages(result.sessions)
  } catch (error) {
    console.warn('[ai-vault] Failed to update session search index:', error)
  }
}

// Why: list IPC is fire-and-forget; overlapping scans must share one exclusive
// sync per db path so the cached store never opens two transactions at once.
export function indexListedSessionMessages(sessions: readonly AiVaultSession[]): Promise<void> {
  const dbPath = messageFtsDbPath()
  let queue = listedSessionMessageIndexByPath.get(dbPath)
  if (!queue) {
    queue = { pending: null, inflight: null }
    listedSessionMessageIndexByPath.set(dbPath, queue)
  }
  queue.pending = sessions
  if (!queue.inflight) {
    queue.inflight = drainListedSessionMessageIndex(dbPath, queue).finally(() => {
      queue.inflight = null
    })
  }
  return queue.inflight
}

async function drainListedSessionMessageIndex(
  dbPath: string,
  queue: ListedSessionMessageIndexQueue
): Promise<void> {
  while (queue.pending) {
    const batch = queue.pending
    queue.pending = null
    try {
      const store = await getAiVaultSessionMessageFtsStore(dbPath)
      await store.sync(batch)
    } catch (error) {
      console.warn('[ai-vault] Failed to update message FTS index:', error)
    }
  }
}

export async function searchListedAiVaultSessions(
  args: AiVaultSearchSessionsArgs
): Promise<AiVaultSearchSessionsResult> {
  if (!isAiVaultRgSearchScope(args.searchScope) || typeof args.query !== 'string') {
    return emptyAiVaultSearchSessionsResult()
  }
  const sessionIds = Array.isArray(args.sessionIds) ? args.sessionIds.map(String) : []
  const sessionsById = new Map<string, AiVaultSession>(
    lastListedSessions.map((session) => [session.id, session])
  )
  const { localIds, remoteSessions } = partitionListedSearchSessions(sessionIds, sessionsById)
  const remoteMatchedIds = matchListedSessionsByCardMetadata(remoteSessions, args.query)
  const fts =
    localIds.length === 0
      ? null
      : await searchListedSessionsWithMessageFts({
          query: args.query,
          searchScope: args.searchScope,
          sessionIds: localIds
        })
  if (!fts) {
    // Why: remote-only lists must not report empty local-rg success; the
    // renderer then card-filters. Mixed lists rg local files only.
    if (localIds.length === 0) {
      return emptyAiVaultSearchSessionsResult()
    }
    const rg = await searchAiVaultSessionsWithRg(
      { query: args.query, searchScope: args.searchScope, sessionIds: localIds },
      sessionsById
    )
    return withRemoteCardMatches(rg, remoteMatchedIds)
  }
  const indexed = new Set(fts.indexedSessionIds)
  const unindexedLocalIds = localIds.filter((id) => !indexed.has(id))
  if (unindexedLocalIds.length === 0) {
    return withRemoteCardMatches(toFtsSearchResult(fts), remoteMatchedIds)
  }
  // Why: only locally readable unindexed transcripts go to desktop rg.
  // SSH/runtime stay on card metadata so a missing remote path is not a miss.
  const rg = await searchAiVaultSessionsWithRg(
    { query: args.query, searchScope: args.searchScope, sessionIds: unindexedLocalIds },
    sessionsById
  )
  return withRemoteCardMatches(
    {
      matchedIds: uniqueStrings([...fts.matchedIds, ...rg.matchedIds]),
      usedRg: rg.usedRg,
      usedFts: true,
      truncated: rg.truncated,
      degraded: fts.degraded,
      hits: fts.hits
    },
    remoteMatchedIds
  )
}

function withRemoteCardMatches(
  result: AiVaultSearchSessionsResult,
  remoteMatchedIds: readonly string[]
): AiVaultSearchSessionsResult {
  if (remoteMatchedIds.length === 0) {
    return result
  }
  return {
    ...result,
    matchedIds: uniqueStrings([...result.matchedIds, ...remoteMatchedIds])
  }
}

async function searchListedSessionsWithMessageFts(
  args: AiVaultSearchSessionsArgs
): Promise<AiVaultMessageFtsSearchResult | null> {
  try {
    const store = await getAiVaultSessionMessageFtsStore(messageFtsDbPath())
    const result = store.search(args)
    if (result.indexedSessionCount === 0) {
      return null
    }
    return result
  } catch (error) {
    console.warn('[ai-vault] Message FTS search failed; falling back to rg:', error)
    return null
  }
}

function toFtsSearchResult(result: AiVaultMessageFtsSearchResult): AiVaultSearchSessionsResult {
  return {
    matchedIds: result.matchedIds,
    usedRg: false,
    usedFts: true,
    truncated: false,
    degraded: result.degraded,
    hits: result.hits
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function messageFtsDbPath(): string {
  return join(app.getPath('userData'), 'ai-vault-session-message-fts.sqlite')
}

export async function rankListedAiVaultSessions(
  args: AiVaultRankSessionsArgs,
  options: ListedSessionSearchOptions
): Promise<AiVaultRankSessionsResult> {
  const settings = options.getSettings?.()
  if (!settings) {
    return {
      ok: true,
      rankedIds: args.cards.map((card) => card.id),
      usedModel: false
    }
  }
  const repo = args.repoId ? (options.getRepo?.(args.repoId) ?? null) : null
  const wslDistro = repo && !repo.connectionId ? options.getWslDistroForRepo?.(repo) : undefined
  return rankAiVaultSessionsWithModel(args, settings, repo, { wslDistro })
}
