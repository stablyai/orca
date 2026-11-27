import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { rpcClientForExecutionHost } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { worktreeCatalogRead } from '../worktree/catalog/worktree-catalog-operations'
import { sessionTabsListRead } from './tabs/mobile-session-tab-read-operations'
import {
  isUnpublishedSnapshot,
  recentCardExecutionHostKey,
  recentCardSnapshotTabs
} from './recent-session-card-snapshot'
import {
  readAllRecentSessionCardsSync,
  reconcileRecentSessionCardsForWorktree,
  removeRecentSessionCard
} from './recent-session-cards'
import { recentCardWorktreeScopeKey } from './recent-session-card-visibility'

export type RecentCardWorktree = {
  worktreeId: string
  executionHost?: ExecutionHostId
  displayName?: string
  isArchived?: boolean
}

export type RecentCardsPollState = {
  worktrees: readonly RecentCardWorktree[]
  confirmedExecutionHosts: ReadonlySet<string>
}

export const EMPTY_RECENT_CARDS_POLL_STATE: RecentCardsPollState = {
  worktrees: [],
  confirmedExecutionHosts: new Set()
}

const cachedPollStateByHost = new Map<string, RecentCardsPollState>()

export function getCachedRecentCardsPollState(hostId: string | undefined): RecentCardsPollState {
  return (hostId && cachedPollStateByHost.get(hostId)) || EMPTY_RECENT_CARDS_POLL_STATE
}

export function clearRecentCardsPollStateForTests(): void {
  cachedPollStateByHost.clear()
}

type ClientResolutionArgs = {
  targetExecutionHost: ExecutionHostId | undefined
  currentExecutionHost: ExecutionHostId | undefined
  currentClient: RpcClient | null
  currentConnState: ConnectionState
  pairedHostClient: RpcClient | null
  pairedHostState: ConnectionState
  hostCapabilities: readonly string[] | null | undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function toRecentCardWorktrees(
  rows: readonly unknown[] | undefined,
  executionHost: ExecutionHostId | undefined
): RecentCardWorktree[] {
  const scopedExec =
    executionHost && recentCardExecutionHostKey(executionHost) !== '' ? executionHost : undefined
  return (rows ?? []).flatMap((row) =>
    isRecord(row) && typeof row.worktreeId === 'string' && row.worktreeId.length > 0
      ? [
          {
            worktreeId: row.worktreeId,
            ...(scopedExec ? { executionHost: scopedExec } : {}),
            displayName: typeof row.displayName === 'string' ? row.displayName : undefined,
            isArchived: typeof row.isArchived === 'boolean' ? row.isArchived : undefined
          }
        ]
      : []
  )
}

export function sameRecentCardsPollState(
  prev: RecentCardsPollState,
  next: RecentCardsPollState
): boolean {
  if (
    prev.confirmedExecutionHosts.size !== next.confirmedExecutionHosts.size ||
    prev.worktrees.length !== next.worktrees.length
  ) {
    return false
  }
  for (const key of prev.confirmedExecutionHosts) {
    if (!next.confirmedExecutionHosts.has(key)) {
      return false
    }
  }
  return prev.worktrees.every(
    (a, i) =>
      a.worktreeId === next.worktrees[i]?.worktreeId &&
      recentCardExecutionHostKey(a.executionHost) ===
        recentCardExecutionHostKey(next.worktrees[i]?.executionHost) &&
      a.displayName === next.worktrees[i]?.displayName &&
      a.isArchived === next.worktrees[i]?.isArchived
  )
}

/** Route to the card's execution host via the paired desktop relay, falling back to the active screen client. */
export function resolveRecentCardClient(args: ClientResolutionArgs): RpcClient | null {
  const {
    targetExecutionHost,
    currentExecutionHost,
    currentClient,
    currentConnState,
    pairedHostClient,
    pairedHostState,
    hostCapabilities
  } = args
  if (pairedHostClient && pairedHostState === 'connected') {
    return rpcClientForExecutionHost(pairedHostClient, hostCapabilities ?? [], targetExecutionHost)
  }
  if (
    recentCardExecutionHostKey(targetExecutionHost) ===
      recentCardExecutionHostKey(currentExecutionHost) &&
    currentConnState === 'connected'
  ) {
    return currentClient
  }
  return null
}

export async function pollRecentCardsAcrossHosts(
  args: Omit<ClientResolutionArgs, 'targetExecutionHost'> & {
    hostId: string
    worktreeId: string
    sessionTabsCount: number
    isCancelled: () => boolean
  }
): Promise<RecentCardsPollState | null> {
  const { hostId, worktreeId, sessionTabsCount, currentExecutionHost, isCancelled, ...clientArgs } =
    args
  const cardsForHost = readAllRecentSessionCardsSync().filter((item) => item.hostId === hostId)
  const catalogTargets = new Map<string, ExecutionHostId | undefined>()
  for (const exec of [
    undefined,
    currentExecutionHost,
    ...cardsForHost.map((card) => card.executionHost)
  ]) {
    const key = recentCardExecutionHostKey(exec)
    if (!catalogTargets.has(key)) {
      catalogTargets.set(key, key ? exec : undefined)
    }
  }

  const worktrees: RecentCardWorktree[] = []
  const confirmedExecutionHosts = new Set<string>()
  const populatedExecutionHosts = new Set<string>()
  await Promise.allSettled(
    [...catalogTargets.entries()].map(async ([execKey, execHost]) => {
      const targetClient = resolveRecentCardClient({
        ...clientArgs,
        currentExecutionHost,
        targetExecutionHost: execHost
      })
      if (!targetClient) {
        return
      }
      const reply = await worktreeCatalogRead.request(targetClient, { limit: 10000 })
      const catalog = !isCancelled() ? worktreeCatalogRead.interpret(reply) : null
      if (
        catalog?.accepted &&
        Array.isArray(catalog.value.worktrees) &&
        catalog.value.unchanged !== true
      ) {
        confirmedExecutionHosts.add(execKey)
        if (catalog.value.worktrees.length > 0) {
          populatedExecutionHosts.add(execKey)
        }
        worktrees.push(...toRecentCardWorktrees(catalog.value.worktrees, execHost))
      }
    })
  )

  if (isCancelled() || !hostId) {
    return null
  }

  const activeWorktreeKeys = new Set(
    worktrees
      .filter((w) => !w.isArchived)
      .map((w) => recentCardWorktreeScopeKey(w.worktreeId, w.executionHost))
  )
  const prunedScopeKeys = new Set<string>()
  for (const item of cardsForHost) {
    const itemExecKey = recentCardExecutionHostKey(item.executionHost)
    const scopeKey = recentCardWorktreeScopeKey(item.worktreeId, item.executionHost)
    if (
      populatedExecutionHosts.has(itemExecKey) &&
      !activeWorktreeKeys.has(scopeKey) &&
      !prunedScopeKeys.has(scopeKey)
    ) {
      prunedScopeKeys.add(scopeKey)
      removeRecentSessionCard(hostId, item.worktreeId, undefined, undefined, item.executionHost)
    }
  }

  const confirmedWorktreeKeys = new Set(
    worktrees.map((w) => recentCardWorktreeScopeKey(w.worktreeId, w.executionHost))
  )
  const currentExecKey = recentCardExecutionHostKey(currentExecutionHost)
  const tabTargets = new Map<string, { worktreeId: string; executionHost?: ExecutionHostId }>()
  for (const item of cardsForHost) {
    const itemExecKey = recentCardExecutionHostKey(item.executionHost)
    if (item.worktreeId === worktreeId && itemExecKey === currentExecKey && sessionTabsCount > 0) {
      continue
    }
    const key = recentCardWorktreeScopeKey(item.worktreeId, item.executionHost)
    if (!confirmedWorktreeKeys.has(key) || prunedScopeKeys.has(key)) {
      continue
    }
    if (!tabTargets.has(key)) {
      tabTargets.set(key, {
        worktreeId: item.worktreeId,
        ...(itemExecKey ? { executionHost: item.executionHost } : {})
      })
    }
  }

  await Promise.allSettled(
    [...tabTargets.values()].map(async (target) => {
      const targetClient = resolveRecentCardClient({
        ...clientArgs,
        currentExecutionHost,
        targetExecutionHost: target.executionHost
      })
      if (!targetClient) {
        return
      }
      const reply = await sessionTabsListRead.request(targetClient, {
        worktree: `id:${target.worktreeId}`
      })
      const snapshot = !isCancelled() && reply.ok ? sessionTabsListRead.interpret(reply) : null
      const liveTabs =
        snapshot !== null && !isUnpublishedSnapshot(snapshot)
          ? recentCardSnapshotTabs(snapshot)
          : null
      if (liveTabs !== null) {
        reconcileRecentSessionCardsForWorktree({
          hostId,
          worktreeId: target.worktreeId,
          executionHost: target.executionHost,
          liveTabs,
          allowEmpty: true
        })
      }
    })
  )

  if (isCancelled()) {
    return null
  }
  const nextState: RecentCardsPollState = { worktrees, confirmedExecutionHosts }
  const prevCached = cachedPollStateByHost.get(hostId)
  if (!prevCached || !sameRecentCardsPollState(prevCached, nextState)) {
    cachedPollStateByHost.set(hostId, nextState)
  }
  return nextState
}
