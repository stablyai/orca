import { useCallback, useEffect, useRef, useState } from 'react'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../src/shared/runtime-types'
import type { LayoutChangeEvent } from 'react-native'
import { Bot } from 'lucide-react-native'
import { getCachedWorktrees } from '../cache/worktree-cache'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
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
import { recentCardSnapshotTabs } from './mobile-terminal-tab-agent'
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

type RecentCardWorktree = {
  worktreeId: string
  displayName?: string
  isArchived?: boolean
}

function recentCardWorktrees(rows: readonly unknown[] | undefined): RecentCardWorktree[] {
  return (rows ?? []).flatMap((row) =>
    typeof row === 'object' &&
    row !== null &&
    'worktreeId' in row &&
    typeof row.worktreeId === 'string' &&
    row.worktreeId.length > 0
      ? [
          {
            worktreeId: row.worktreeId,
            displayName:
              'displayName' in row && typeof row.displayName === 'string'
                ? row.displayName
                : undefined,
            isArchived:
              'isArchived' in row && typeof row.isArchived === 'boolean'
                ? row.isArchived
                : undefined
          }
        ]
      : []
  )
}

function isUnpublishedSnapshot(snapshot: unknown): boolean {
  return (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'publicationEpoch' in snapshot &&
    snapshot.publicationEpoch === UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
  )
}

export function useMobileSessionPanelRouteActions(scope: MobileSessionPresentationModel) {
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
    handleCreateTerminal
  } = scope
  const noop = () => {}
  const buildAgentRows = <T,>(
    errorHint: string,
    mapOption: (option: (typeof createTabAgentOptions)[number]) => T
  ) =>
    createTabAgentLoadState === 'loading'
      ? [{ label: 'Detecting Agents', icon: Bot, disabled: true, loading: true, onPress: noop }]
      : createTabAgentOptions.length > 0
        ? createTabAgentOptions.map(mapOption)
        : createTabAgentLoadState === 'loaded'
          ? [{ label: 'No Enabled Agents', icon: Bot, disabled: true, onPress: noop }]
          : createTabAgentLoadState === 'other-runtime'
            ? [
                {
                  label: 'Agents on Another Server',
                  hint: 'Pair that server directly',
                  icon: Bot,
                  disabled: true,
                  onPress: noop
                }
              ]
            : createTabAgentLoadState === 'error'
              ? [
                  {
                    label: 'Agent Presets Unavailable',
                    hint: errorHint,
                    icon: Bot,
                    disabled: true,
                    onPress: noop
                  }
                ]
              : []
  const createTabAgentActions = buildAgentRows('Check the host connection', (option) => ({
    label: option.label,
    renderIcon: () => <MobileAgentIcon agentId={option.agent} size={16} />,
    onPress: () => {
      setShowCreateTabDrawer(false)
      void handleCreateTerminal(option.agent)
    }
  }))
  const sendDiffNotesAgentActions =
    pendingDiffNotesDelivery === null
      ? []
      : buildAgentRows('Copy notes instead', (option) => ({
          label: option.label,
          hint: 'New agent session',
          icon: Bot,
          onPress: () => {
            const delivery = pendingDiffNotesDelivery
            setPendingDiffNotesDelivery(null)
            if (delivery) {
              void sendDiffNotesToNewAgent(delivery, async () => {
                await handleCreateTerminal(option.agent, {
                  initialPrompt: delivery.prompt,
                  onPromptSent: () => void clearDeliveredDiffComments(delivery.comments)
                })
              })
            }
          }
        }))

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
        ...(action.panel === 'sourceControl' || action.panel === 'pr' ? { origin: 'session' } : {}),
        ...descriptor.params,
        ...workspaceRouteParams(executionHost)
      }
    })
  }

  const openAgentSessionHistory = () => {
    const params = new URLSearchParams({ name: worktreeName || '' })
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
  const [, setRecentCardsRevision] = useState(0)
  useEffect(() => subscribeRecentSessionCards(() => setRecentCardsRevision((rev) => rev + 1)), [])
  const [recentCardsWorktrees, setRecentCardsWorktrees] = useState<readonly RecentCardWorktree[]>(
    () => recentCardWorktrees(getCachedWorktrees(hostId) ?? undefined)
  )
  useEffect(() => {
    if (
      !client ||
      connState !== 'connected' ||
      (!showHeaderMoreActions && !showRecentSessionCards)
    ) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const reply = await worktreeCatalogRead.request(client, { limit: 10000 })
        const catalog = !cancelled ? worktreeCatalogRead.interpret(reply) : null
        const next = catalog?.accepted ? recentCardWorktrees(catalog.value.worktrees) : []
        if (next.length > 0) {
          setRecentCardsWorktrees(next)
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
            .filter((item) => item.hostId === hostId)
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
    })()
    return () => {
      cancelled = true
    }
  }, [client, connState, hostId, showHeaderMoreActions, showRecentSessionCards])
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
    createTabBusy
  }
}

export type MobileSessionPanelRouteActionsModel = MobileSessionPresentationModel &
  ReturnType<typeof useMobileSessionPanelRouteActions>
