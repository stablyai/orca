import { useCallback, useEffect, useRef, useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { Bot } from 'lucide-react-native'
import { getCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref,
  workspaceRouteParams
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
import {
  type ActivePanel,
  resolvePanelAction,
  shouldShowSessionHeaderChecksAction,
  panelRouteDescriptor
} from './session-panel-host'
import type { MobileSessionPresentationModel } from './use-mobile-session-presentation'

export function useMobileSessionPanelRouteActions(scope: MobileSessionPresentationModel) {
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const {
    hostId,
    worktreeId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    client,
    connState,
    router,
    worktreeName,
    sessionTabs,
    activeSessionTabId,
    switchSessionTab,
    showToast,
    showHeaderMoreActions,
    setShowHeaderMoreActions,
    showRecentSessionCards,
    setShowRecentSessionCards,
    activePanel,
    setActivePanel,
    setSessionContentRowWidth,
    canDockPanel,
    prRepoContextLoaded,
    prIsGithubRepo,
    pendingDiffNotesDelivery,
    setPendingDiffNotesDelivery,
    creating,
    creatingBrowser,
    creatingMarkdown,
    setShowCreateTabDrawer,
    createTabAgentLoadState,
    createTabAgentOptions,
    agentSessionHistorySupported,
    clearDeliveredDiffComments,
    sendDiffNotesToNewAgent,
    handleCreateTerminal,
    setCreateError,
    setShowQuickCommands,
    quickCommandsSupported,
    showToast
  } = scope
  const noop = () => {}
  const otherRuntimeAgentRow = {
    id: 'otherServerAgents',
    label: t('session.usePanelRouteActions.otherServerAgents', 'Agents on Another Server'),
    hint: t('session.usePanelRouteActions.pairServerHint', 'Pair that server directly'),
    icon: Bot,
    disabled: true,
    onPress: noop
  }
  const buildAgentRows = <T,>(
    errorHint: string,
    mapOption: (option: (typeof createTabAgentOptions)[number]) => T
  ) =>
    createTabAgentLoadState === 'loading'
      ? [
          {
            id: 'detectingAgents',
            label: t('session.usePanelRouteActions.detectingAgents', 'Detecting Agents'),
            icon: Bot,
            disabled: true,
            loading: true,
            onPress: noop
          }
        ]
      : createTabAgentOptions.length > 0
        ? createTabAgentOptions.map(mapOption)
        : createTabAgentLoadState === 'loaded'
          ? [
              {
                id: 'noEnabledAgents',
                label: t('session.usePanelRouteActions.noEnabledAgents', 'No Enabled Agents'),
                icon: Bot,
                disabled: true,
                onPress: noop
              }
            ]
          : createTabAgentLoadState === 'other-runtime'
            ? [otherRuntimeAgentRow]
            : createTabAgentLoadState === 'error'
              ? [
                  {
                    id: 'presetsUnavailable',
                    label: t(
                      'session.usePanelRouteActions.presetsUnavailable',
                      'Agent Presets Unavailable'
                    ),
                    hint: errorHint,
                    icon: Bot,
                    disabled: true,
                    onPress: noop
                  }
                ]
              : []
  const createTabAgentActions = buildAgentRows(
    t('session.usePanelRouteActions.checkHostHint', 'Check the host connection'),
    (option) => ({
      id: `agent:${option.agent}`,
      label: option.label,
      renderIcon: () => <MobileAgentIcon agentId={option.agent} size={16} />,
      onPress: () => {
        setShowCreateTabDrawer(false)
        void handleCreateTerminal(option.agent)
      }
    })
  )
  const sendDiffNotesAgentActions =
    pendingDiffNotesDelivery === null
      ? []
      : buildAgentRows(
          t('session.usePanelRouteActions.copyNotesHint', 'Copy notes instead'),
          (option) => ({
            id: `agent:${option.agent}`,
            label: option.label,
            hint: t('session.usePanelRouteActions.newSessionHint', 'New agent session'),
            icon: Bot,
            onPress: () => {
              const delivery = pendingDiffNotesDelivery
              setPendingDiffNotesDelivery(null)
              if (!delivery) {
                return
              }
              void sendDiffNotesToNewAgent(delivery, async () => {
                await handleCreateTerminal(option.agent, {
                  initialPrompt: delivery.prompt,
                  onPromptSent: () => void clearDeliveredDiffComments(delivery.comments)
                })
              })
            }
          })
        )

  const handleSessionContentRowLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    setSessionContentRowWidth((prev) => (prev === width ? prev : width))
  }, [])

  const handlePanelTap = (tapped: Exclude<ActivePanel, null>) => {
    const action = resolvePanelAction({ canDock: canDockPanel, tapped, current: activePanel })
    if (action.kind === 'dock') {
      setActivePanel(action.next)
      return
    }
    const descriptor = panelRouteDescriptor(action.panel)
    router.push({
      pathname: descriptor.pathname,
      params: {
        hostId,
        worktreeId,
        name: worktreeName || '',
        // Source-control/PR origin enables dismissal after diff open; Files must not inherit it.
        ...(action.panel === 'sourceControl' || action.panel === 'pr' ? { origin: 'session' } : {}),
        ...descriptor.params,
        ...workspaceRouteParams(executionHost)
      }
    })
  }

  const openAgentSessionHistory = () => {
    const params = new URLSearchParams({ name: worktreeName || '', origin: 'session' })
    router.push(
      workspaceRouteHref(
        `/h/${hostId}/agent-history/${encodeURIComponent(worktreeId)}?${params.toString()}`,
        executionHost
      )
    )
  }
  const showAgentSessionHistoryAction =
    !isFolderWorkspaceRoute && !isFloatingWorkspaceRoute && agentSessionHistorySupported === true
  const showChecksAction = shouldShowSessionHeaderChecksAction({
    isFolderWorkspaceRoute: isFolderWorkspaceRoute || isFloatingWorkspaceRoute,
    repoContextLoaded: prRepoContextLoaded,
    hostedChecksSupported: prIsGithubRepo
  })
  const showRecentSessionCardsAction = !isFloatingWorkspaceRoute
  const showHeaderMoreButton =
    showRecentSessionCardsAction || showAgentSessionHistoryAction || showChecksAction
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
        showToast('Card was closed')
      }
      return
    }
    if (!client || connState !== 'connected') {
      triggerError()
      showToast('Waiting for host…')
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
          showToast('Workspace no longer exists')
          closeRecentCardSheets()
          return
        }
        showToast('Card was closed; opening workspace')
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
  const createTabBusy = creating || creatingBrowser || creatingMarkdown
  const handleOpenNewTab = () => {
    setCreateError('')
    setShowCreateTabDrawer(true)
  }
  const handleOpenQuickCommands = () => {
    if (quickCommandsSupported === true) {
      setShowQuickCommands(true)
      return
    }
    showToast(
      quickCommandsSupported === false
        ? t(
            'session.tabStrip.quickCommandsUpdateRequired',
            'Desktop update required for quick commands'
          )
        : t(
            'session.tabStrip.checkingCapabilities',
            'Checking desktop capabilities — try again in a moment'
          ),
      1600
    )
  }
  return {
    createTabAgentActions,
    sendDiffNotesAgentActions,
    handleSessionContentRowLayout,
    handlePanelTap,
    openAgentSessionHistory,
    showAgentSessionHistoryAction,
    showChecksAction,
    showRecentSessionCardsAction,
    recentSessionCards,
    jumpingRecentCardKey,
    handleSelectRecentSessionCard,
    showHeaderMoreButton,
    createTabBusy,
    handleOpenNewTab,
    handleOpenQuickCommands
  }
}

export type MobileSessionPanelRouteActionsModel = MobileSessionPresentationModel &
  ReturnType<typeof useMobileSessionPanelRouteActions>
