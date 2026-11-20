import { useEffect, useMemo, useRef, useState } from 'react'
import { BOTTOM_DRAWER_SHOW_DURATION_MS } from '../components/bottom-drawer/bottom-drawer-constants'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import { worktreeCatalogRead } from '../worktree/catalog/worktree-catalog-operations'
import { sessionTabsListRead } from './tabs/mobile-session-tab-read-operations'
import {
  activateMobileSessionTab,
  setPendingCrossWorktreeTabTarget
} from './tabs/mobile-session-tab-activation'
import { isUnpublishedSnapshot, recentCardSnapshotTabs } from './recent-session-card-snapshot'
import {
  getVisibleRecentSessionCards,
  readAllRecentSessionCardsSync,
  reconcileRecentSessionCardsForWorktree,
  removeRecentSessionCard,
  subscribeRecentSessionCards,
  type RecentSessionCardRecord
} from './recent-session-cards'
import type { MobileSessionPresentationModel } from './use-mobile-session-presentation'

const EMPTY_RECENT_SESSION_CARDS: readonly RecentSessionCardRecord[] = []
const POLL_INTERVAL_MS = 2500

type RecentCardWorktree = {
  worktreeId: string
  displayName?: string
  isArchived?: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function toRecentCardWorktrees(rows: readonly unknown[] | undefined): RecentCardWorktree[] {
  return (rows ?? []).flatMap((row) =>
    isRecord(row) && typeof row.worktreeId === 'string' && row.worktreeId.length > 0
      ? [
          {
            worktreeId: row.worktreeId,
            displayName: typeof row.displayName === 'string' ? row.displayName : undefined,
            isArchived: typeof row.isArchived === 'boolean' ? row.isArchived : undefined
          }
        ]
      : []
  )
}

function sameRecentCardWorktrees(
  prev: readonly RecentCardWorktree[],
  next: readonly RecentCardWorktree[]
): boolean {
  return (
    prev === next ||
    (prev.length === next.length &&
      prev.every(
        (a, i) =>
          a.worktreeId === next[i]?.worktreeId &&
          a.displayName === next[i]?.displayName &&
          a.isArchived === next[i]?.isArchived
      ))
  )
}

export function useRecentSessionCardMenu(scope: MobileSessionPresentationModel) {
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const {
    hostId,
    worktreeId,
    client,
    connState,
    router,
    sessionTabs,
    activeSessionTabId,
    switchSessionTab,
    showToast,
    showHeaderMoreActions,
    setShowHeaderMoreActions,
    showRecentSessionCards,
    setShowRecentSessionCards
  } = scope
  const isRecentCardsOpen = Boolean(showRecentSessionCards || showHeaderMoreActions)
  const [jumpingRecentCardKey, setJumpingRecentCardKey] = useState<string | null>(null)
  const jumpLockRef = useRef(false)
  const recentCardsPollInFlightRef = useRef(false)
  const [recentCardsRevision, setRecentCardsRevision] = useState(0)
  const [recentCardsWorktrees, setRecentCardsWorktrees] = useState<readonly RecentCardWorktree[]>(
    []
  )

  useEffect(() => {
    if (!isRecentCardsOpen) {
      return
    }
    return subscribeRecentSessionCards(() => setRecentCardsRevision((rev) => rev + 1))
  }, [isRecentCardsOpen])

  useEffect(() => {
    if (!isRecentCardsOpen || !client || connState !== 'connected') {
      return
    }
    let cancelled = false
    const pollRecentCards = async () => {
      try {
        const reply = await worktreeCatalogRead.request(client, { limit: 10000 })
        const catalog = !cancelled ? worktreeCatalogRead.interpret(reply) : null
        if (catalog?.accepted && Array.isArray(catalog.value.worktrees)) {
          const next = toRecentCardWorktrees(catalog.value.worktrees)
          setRecentCardsWorktrees((prev) => (sameRecentCardWorktrees(prev, next) ? prev : next))
        }
      } catch {
        // A refused catalog leaves the cached rows in place.
      }
      if (!hostId || cancelled) {
        return
      }
      const ids = Array.from(
        new Set(
          readAllRecentSessionCardsSync()
            .filter(
              (item) =>
                item.hostId === hostId &&
                (item.worktreeId !== worktreeId || sessionTabs.length === 0)
            )
            .map((item) => item.worktreeId)
        )
      )
      await Promise.allSettled(
        ids.map(async (targetId) => {
          const reply = await sessionTabsListRead.request(client, { worktree: `id:${targetId}` })
          const snapshot = !cancelled && reply.ok ? sessionTabsListRead.interpret(reply) : null
          const liveTabs =
            snapshot !== null && !isUnpublishedSnapshot(snapshot)
              ? recentCardSnapshotTabs(snapshot)
              : null
          if (liveTabs !== null) {
            reconcileRecentSessionCardsForWorktree({
              hostId,
              worktreeId: targetId,
              liveTabs,
              allowEmpty: true
            })
          }
        })
      )
    }
    const tick = async () => {
      if (recentCardsPollInFlightRef.current || cancelled) {
        return
      }
      recentCardsPollInFlightRef.current = true
      try {
        await pollRecentCards()
      } finally {
        recentCardsPollInFlightRef.current = false
      }
    }
    const settleTimer = setTimeout(() => {
      void tick()
    }, BOTTOM_DRAWER_SHOW_DURATION_MS)
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(settleTimer)
      clearInterval(timer)
    }
  }, [
    activeSessionTabId,
    client,
    connState,
    hostId,
    isRecentCardsOpen,
    sessionTabs.length,
    worktreeId
  ])

  const recentSessionCards = useMemo(() => {
    if (!isRecentCardsOpen) {
      return EMPTY_RECENT_SESSION_CARDS
    }
    void recentCardsRevision
    return getVisibleRecentSessionCards({
      hostId,
      currentWorktreeId: worktreeId,
      currentTabId: activeSessionTabId,
      liveWorktrees: recentCardsWorktrees,
      currentWorktreeTabs: sessionTabs
    })
  }, [
    activeSessionTabId,
    hostId,
    isRecentCardsOpen,
    recentCardsRevision,
    recentCardsWorktrees,
    sessionTabs,
    worktreeId
  ])

  const closeRecentCardSheets = () => {
    setShowRecentSessionCards(false)
    setShowHeaderMoreActions(false)
  }

  const handleSelectRecentSessionCard = async (card: RecentSessionCardRecord) => {
    if (jumpingRecentCardKey !== null || jumpLockRef.current) {
      return
    }
    if (card.worktreeId === worktreeId) {
      if (card.tabId === activeSessionTabId) {
        closeRecentCardSheets()
        return
      }
      const targetTab = sessionTabs.find(
        (tab) =>
          tab.id === card.tabId ||
          (tab.type === 'terminal' &&
            Boolean(card.terminalHandle) &&
            tab.terminal === card.terminalHandle)
      )
      closeRecentCardSheets()
      if (targetTab) {
        switchSessionTab(targetTab)
        triggerSuccess()
      } else {
        removeRecentSessionCard(hostId, card.worktreeId, card.tabId)
        triggerError()
        showToast(t('session.recentSessionCards.cardClosed', 'Card was closed'))
      }
      return
    }
    if (!client || connState !== 'connected') {
      triggerError()
      showToast(t('session.recentSessionCards.waitingForHost', 'Waiting for host…'))
      return
    }
    jumpLockRef.current = true
    setJumpingRecentCardKey(`${card.worktreeId}:${card.tabId}`)
    try {
      setPendingCrossWorktreeTabTarget({
        worktreeId: card.worktreeId,
        tabId: card.tabId,
        leafId: card.leafId,
        terminalHandle: card.terminalHandle
      })
      const response = await activateMobileSessionTab(client, {
        worktree: `id:${card.worktreeId}`,
        tabId: card.tabId,
        ...(card.leafId ? { leafId: card.leafId } : {}),
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      })
      if (!response.ok) {
        setPendingCrossWorktreeTabTarget(null)
        if (response.error.code === 'repo_not_found') {
          removeRecentSessionCard(hostId, card.worktreeId, card.tabId)
        }
        if (
          response.error.code === 'repo_not_found' ||
          response.error.code === 'selector_not_found'
        ) {
          triggerError()
          showToast(t('session.recentSessionCards.workspaceGone', 'Workspace no longer exists'))
          closeRecentCardSheets()
          return
        }
        showToast(
          t(
            'session.recentSessionCards.cardClosedOpeningWorkspace',
            'Card was closed; opening workspace'
          )
        )
      } else {
        triggerSuccess()
      }
      closeRecentCardSheets()
      const query = card.worktreeName ? `?name=${encodeURIComponent(card.worktreeName)}` : ''
      router.replace(
        workspaceRouteHref(
          `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(card.worktreeId)}${query}`,
          executionHost
        )
      )
    } catch {
      setPendingCrossWorktreeTabTarget(null)
      triggerError()
    } finally {
      jumpLockRef.current = false
      setJumpingRecentCardKey(null)
    }
  }

  return { recentSessionCards, jumpingRecentCardKey, handleSelectRecentSessionCard }
}
