import { useEffect, useRef, useState } from 'react'
import { getCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref
} from '../navigation/workspace-execution-host'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { sessionTabsListRead } from './mobile-session-read-operations'
import {
  activateMobileSessionTab,
  setPendingCrossWorktreeTabTarget
} from './mobile-session-tab-activation'
import {
  recentCardSnapshotTabs,
  subscribeCatalogWorktreesForTabStatus
} from './mobile-terminal-tab-agent'
import {
  isUnpublishedSnapshot,
  recentCardWorktrees,
  type RecentCardWorktree
} from './session-tab-catalog-agent-status'
import {
  getVisibleRecentSessionCards,
  readAllRecentSessionCardsSync,
  reconcileRecentSessionCardsForWorktree,
  removeRecentSessionCard,
  subscribeRecentSessionCards,
  type RecentSessionCardRecord
} from './recent-session-cards'
import type { MobileSessionPresentationModel } from './use-mobile-session-presentation'

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
  const [jumpingRecentCardKey, setJumpingRecentCardKey] = useState<string | null>(null)
  const jumpLockRef = useRef(false)
  const recentCardsPollInFlightRef = useRef(false)
  const [, setRecentCardsRevision] = useState(0)
  useEffect(() => subscribeRecentSessionCards(() => setRecentCardsRevision((rev) => rev + 1)), [])
  useEffect(
    () => subscribeCatalogWorktreesForTabStatus(() => setRecentCardsRevision((rev) => rev + 1)),
    []
  )
  const [recentCardsWorktrees, setRecentCardsWorktrees] = useState<readonly RecentCardWorktree[]>(
    () => recentCardWorktrees(getCachedWorktrees(hostId) ?? undefined)
  )
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    let cancelled = false
    const pollRecentCards = async () => {
      let catalogRows: readonly unknown[] | undefined = getCachedWorktrees(hostId) ?? undefined
      recentCardWorktrees(catalogRows)
      try {
        const reply = await worktreeCatalogRead.request(client, { limit: 10000 })
        const catalog = !cancelled ? worktreeCatalogRead.interpret(reply) : null
        if (catalog?.accepted && Array.isArray(catalog.value.worktrees)) {
          catalogRows = catalog.value.worktrees
          if (hostId) {
            setCachedWorktrees(hostId, catalog.value.worktrees, { proven: true })
          }
          const next = recentCardWorktrees(catalogRows)
          if (next.length > 0) {
            setRecentCardsWorktrees(next)
          }
        }
      } catch {
        // A refused catalog leaves the cached rows in place.
      }
      if (!hostId || cancelled || (!showHeaderMoreActions && !showRecentSessionCards)) {
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
              ? recentCardSnapshotTabs(snapshot, { worktreeId: targetId, worktrees: catalogRows })
              : null
          if (liveTabs !== null) {
            reconcileRecentSessionCardsForWorktree({
              hostId,
              worktreeId: targetId,
              liveTabs,
              allowEmpty: true,
              activeTabId: targetId === worktreeId ? activeSessionTabId : null
            })
          }
        })
      )
    }
    const tick = async () => {
      if (recentCardsPollInFlightRef.current) {
        return
      }
      recentCardsPollInFlightRef.current = true
      try {
        await pollRecentCards()
      } finally {
        recentCardsPollInFlightRef.current = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [
    activeSessionTabId,
    client,
    connState,
    hostId,
    sessionTabs.length,
    showHeaderMoreActions,
    showRecentSessionCards,
    worktreeId
  ])
  const recentSessionCards = getVisibleRecentSessionCards({
    hostId,
    currentWorktreeId: worktreeId,
    currentTabId: activeSessionTabId,
    liveWorktrees: recentCardsWorktrees,
    currentWorktreeTabs: sessionTabs
  })
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
