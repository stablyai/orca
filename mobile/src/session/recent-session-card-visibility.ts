import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import {
  recentCardExecutionHostKey,
  syncRecentCardWithLiveTab,
  type LiveRecentCardTab,
  type RecentSessionCardSnapshot
} from './recent-session-card-snapshot'

export type LiveRecentCardWorktree = {
  worktreeId: string
  executionHost?: ExecutionHostId
  displayName?: string
  isArchived?: boolean
}

export const recentCardWorktreeScopeKey = (
  worktreeId: string,
  executionHost?: string | null
): string => `${recentCardExecutionHostKey(executionHost)}\0${worktreeId}`

export const recentCardStorageKey = (card: RecentSessionCardSnapshot): string =>
  `${card.hostId}\0${recentCardWorktreeScopeKey(card.worktreeId, card.executionHost)}\0${card.tabId}`

export const recentCardMatchesTab = (
  card: RecentSessionCardSnapshot,
  tab: LiveRecentCardTab
): boolean =>
  tab.id === card.tabId || (Boolean(card.terminalHandle) && tab.terminal === card.terminalHandle)

export function capRecentCardList(
  cards: readonly RecentSessionCardSnapshot[],
  maxPerHost: number,
  maxTotal: number
): RecentSessionCardSnapshot[] {
  const perHost = new Map<string, number>()
  return cards
    .filter((i) => {
      const n = (perHost.get(i.hostId) ?? 0) + 1
      perHost.set(i.hostId, n)
      return n <= maxPerHost
    })
    .slice(0, maxTotal)
}

export function mergeRecentCardListsByRecency(
  primary: readonly RecentSessionCardSnapshot[],
  secondary: readonly RecentSessionCardSnapshot[]
): RecentSessionCardSnapshot[] {
  const byKey = new Map<string, RecentSessionCardSnapshot>()
  for (const c of [...secondary, ...primary]) {
    if ((byKey.get(recentCardStorageKey(c))?.lastVisitedAt ?? -Infinity) <= c.lastVisitedAt) {
      byKey.set(recentCardStorageKey(c), c)
    }
  }
  return [...byKey.values()].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
}

export function reconcileRecentSessionCardList(
  current: readonly RecentSessionCardSnapshot[],
  p: {
    hostId: string
    worktreeId: string
    executionHost?: ExecutionHostId
    liveTabs: readonly LiveRecentCardTab[]
  }
): { next: RecentSessionCardSnapshot[]; changed: boolean } {
  const execKey = recentCardExecutionHostKey(p.executionHost)
  let changed = false
  const next = current.flatMap((i) => {
    if (
      i.hostId !== p.hostId ||
      i.worktreeId !== p.worktreeId ||
      recentCardExecutionHostKey(i.executionHost) !== execKey
    ) {
      return [i]
    }
    const match = p.liveTabs.find((t) => recentCardMatchesTab(i, t))
    const updated = match ? syncRecentCardWithLiveTab(i, match) : null
    changed ||= updated !== i
    return updated ? [updated] : []
  })
  return { next, changed }
}

export function filterVisibleRecentSessionCards(
  cards: readonly RecentSessionCardSnapshot[],
  p: {
    hostId: string
    currentWorktreeId: string
    currentExecutionHost?: ExecutionHostId
    currentTabId: string | null
    limit: number
    liveWorktrees?: readonly LiveRecentCardWorktree[]
    confirmedExecutionHosts?: ReadonlySet<string>
    currentWorktreeTabs?: readonly LiveRecentCardTab[]
  }
): RecentSessionCardSnapshot[] {
  const live = p.liveWorktrees?.length
    ? new Map(
        p.liveWorktrees.map((w) => [recentCardWorktreeScopeKey(w.worktreeId, w.executionHost), w])
      )
    : null
  const currentExec = recentCardExecutionHostKey(p.currentExecutionHost)
  const tabs = p.currentWorktreeTabs
  return cards
    .filter((i) => {
      const cardExec = recentCardExecutionHostKey(i.executionHost)
      const inCurrent = i.worktreeId === p.currentWorktreeId && cardExec === currentExec
      const isCurrent = Boolean(p.currentTabId) && inCurrent && i.tabId === p.currentTabId
      const closed =
        Boolean(tabs?.length) && inCurrent && !tabs?.some((t) => recentCardMatchesTab(i, t))
      const liveRow = live?.get(recentCardWorktreeScopeKey(i.worktreeId, i.executionHost))
      const activeWt = p.confirmedExecutionHosts
        ? !p.confirmedExecutionHosts.has(cardExec) || Boolean(liveRow && !liveRow.isArchived)
        : !live || Boolean(liveRow && !liveRow.isArchived)
      return i.hostId === p.hostId && !isCurrent && activeWt && !closed
    })
    .slice(0, p.limit)
    .map((i) => {
      const match =
        i.worktreeId === p.currentWorktreeId &&
        recentCardExecutionHostKey(i.executionHost) === currentExec
          ? tabs?.find((t) => recentCardMatchesTab(i, t))
          : undefined
      const synced = syncRecentCardWithLiveTab(i, match)
      const liveRow = live?.get(recentCardWorktreeScopeKey(i.worktreeId, i.executionHost))
      return {
        ...synced,
        worktreeName: liveRow?.displayName || synced.worktreeName
      }
    })
}
