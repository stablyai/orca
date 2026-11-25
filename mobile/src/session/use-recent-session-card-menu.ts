import { useEffect, useMemo, useRef, useState } from 'react'
import { BOTTOM_DRAWER_SHOW_DURATION_MS } from '../components/bottom-drawer/bottom-drawer-constants'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import {
  activateMobileSessionTab,
  setPendingCrossWorktreeTabTarget
} from './tabs/mobile-session-tab-activation'
import { recentCardExecutionHostKey, recentCardRowKey } from './recent-session-card-snapshot'
import {
  getCachedRecentCardsPollState,
  pollRecentCardsAcrossHosts,
  resolveRecentCardClient,
  sameRecentCardsPollState,
  type RecentCardsPollState
} from './recent-session-card-routing'
import {
  getVisibleRecentSessionCards,
  removeRecentSessionCard,
  subscribeRecentSessionCards,
  type RecentSessionCardRecord
} from './recent-session-cards'
import type { MobileSessionPresentationModel } from './use-mobile-session-presentation'

const EMPTY_RECENT_SESSION_CARDS: readonly RecentSessionCardRecord[] = []
const POLL_INTERVAL_MS = 2500

export function useRecentSessionCardMenu(scope: MobileSessionPresentationModel) {
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const {
    hostId,
    worktreeId,
    client,
    connState,
    pairedHostClient,
    pairedHostState,
    hostCapabilities,
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
  const [recentCardsPollState, setRecentCardsPollState] = useState<RecentCardsPollState>(() =>
    getCachedRecentCardsPollState(hostId)
  )

  useEffect(() => {
    const cached = getCachedRecentCardsPollState(hostId)
    setRecentCardsPollState((prev) => (sameRecentCardsPollState(prev, cached) ? prev : cached))
  }, [hostId])

  useEffect(() => {
    if (!isRecentCardsOpen) {
      return
    }
    return subscribeRecentSessionCards(() => setRecentCardsRevision((rev) => rev + 1))
  }, [isRecentCardsOpen])

  const anyHostConnected = connState === 'connected' || pairedHostState === 'connected'
  useEffect(() => {
    if (!isRecentCardsOpen || !anyHostConnected) {
      return
    }
    let cancelled = false
    const tick = async () => {
      if (recentCardsPollInFlightRef.current || cancelled || !hostId) {
        return
      }
      recentCardsPollInFlightRef.current = true
      try {
        const next = await pollRecentCardsAcrossHosts({
          hostId,
          worktreeId,
          sessionTabsCount: sessionTabs.length,
          currentExecutionHost: executionHost,
          currentClient: client,
          currentConnState: connState,
          pairedHostClient,
          pairedHostState,
          hostCapabilities,
          isCancelled: () => cancelled
        })
        if (next && !cancelled) {
          setRecentCardsPollState((prev) => (sameRecentCardsPollState(prev, next) ? prev : next))
        }
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
    anyHostConnected,
    client,
    connState,
    executionHost,
    hostCapabilities,
    hostId,
    isRecentCardsOpen,
    pairedHostClient,
    pairedHostState,
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
      currentExecutionHost: executionHost,
      currentTabId: activeSessionTabId,
      liveWorktrees: recentCardsPollState.worktrees,
      confirmedExecutionHosts: recentCardsPollState.confirmedExecutionHosts,
      currentWorktreeTabs: sessionTabs
    })
  }, [
    activeSessionTabId,
    executionHost,
    hostId,
    isRecentCardsOpen,
    recentCardsPollState,
    recentCardsRevision,
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
    const isSameWorktree =
      card.worktreeId === worktreeId &&
      recentCardExecutionHostKey(card.executionHost) === recentCardExecutionHostKey(executionHost)
    if (isSameWorktree) {
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
        removeRecentSessionCard(hostId, card.worktreeId, card.tabId, undefined, card.executionHost)
        triggerError()
        showToast(t('session.recentSessionCards.cardClosed', 'Card was closed'))
      }
      return
    }
    const targetClient = resolveRecentCardClient({
      targetExecutionHost: card.executionHost,
      currentExecutionHost: executionHost,
      currentClient: client,
      currentConnState: connState,
      pairedHostClient,
      pairedHostState,
      hostCapabilities
    })
    if (!targetClient) {
      triggerError()
      showToast(t('session.recentSessionCards.waitingForHost', 'Waiting for host…'))
      return
    }
    jumpLockRef.current = true
    setJumpingRecentCardKey(recentCardRowKey(card))
    try {
      setPendingCrossWorktreeTabTarget({
        worktreeId: card.worktreeId,
        tabId: card.tabId,
        leafId: card.leafId,
        terminalHandle: card.terminalHandle
      })
      const response = await activateMobileSessionTab(targetClient, {
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
          removeRecentSessionCard(
            hostId,
            card.worktreeId,
            card.tabId,
            undefined,
            card.executionHost
          )
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
          card.executionHost ?? null
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
