import { useCallback } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { Bot } from 'lucide-react-native'
import {
  type ActivePanel,
  resolvePanelAction,
  shouldShowSessionHeaderChecksAction,
  panelRouteDescriptor
} from './session-panel-host'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import type { MobileSessionPresentationModel } from './use-mobile-session-presentation'

export function useMobileSessionPanelRouteActions(scope: MobileSessionPresentationModel) {
  const {
    hostId,
    worktreeId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    router,
    worktreeName,
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
    handleCreateTerminal
  } = scope
  const createTabAgentActions =
    createTabAgentLoadState === 'loading'
      ? [
          {
            label: 'Detecting Agents',
            icon: Bot,
            disabled: true,
            loading: true,
            onPress: () => {}
          }
        ]
      : createTabAgentOptions.length > 0
        ? createTabAgentOptions.map((option) => ({
            label: option.label,
            renderIcon: () => <MobileAgentIcon agentId={option.agent} size={16} />,
            onPress: () => {
              setShowCreateTabDrawer(false)
              void handleCreateTerminal(option.agent)
            }
          }))
        : createTabAgentLoadState === 'loaded'
          ? [
              {
                label: 'No Enabled Agents',
                icon: Bot,
                disabled: true,
                onPress: () => {}
              }
            ]
          : createTabAgentLoadState === 'error'
            ? [
                {
                  label: 'Agent Presets Unavailable',
                  hint: 'Check the host connection',
                  icon: Bot,
                  disabled: true,
                  onPress: () => {}
                }
              ]
            : []
  const sendDiffNotesAgentActions =
    pendingDiffNotesDelivery === null
      ? []
      : createTabAgentLoadState === 'loading'
        ? [
            {
              label: 'Detecting Agents',
              icon: Bot,
              disabled: true,
              loading: true,
              onPress: () => {}
            }
          ]
        : createTabAgentOptions.length > 0
          ? createTabAgentOptions.map((option) => ({
              label: option.label,
              hint: 'New agent session',
              icon: Bot,
              onPress: () => {
                const delivery = pendingDiffNotesDelivery
                setPendingDiffNotesDelivery(null)
                if (!delivery) {
                  return
                }
                void handleCreateTerminal(option.agent, {
                  initialPrompt: delivery.prompt,
                  onPromptSent: () => void clearDeliveredDiffComments(delivery.comments)
                })
              }
            }))
          : createTabAgentLoadState === 'loaded'
            ? [
                {
                  label: 'No Enabled Agents',
                  icon: Bot,
                  disabled: true,
                  onPress: () => {}
                }
              ]
            : createTabAgentLoadState === 'error'
              ? [
                  {
                    label: 'Agent Presets Unavailable',
                    hint: 'Copy notes instead',
                    icon: Bot,
                    disabled: true,
                    onPress: () => {}
                  }
                ]
              : []

  // Panel-icon taps route through the dock-vs-push decision (U1): dock-capable rows dock, constrained rows push.
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
        // SC + PR both land on the source-control hub with origin:'session' for post-diff-open dismissal (U2); Files opts out.
        ...(action.panel === 'sourceControl' || action.panel === 'pr' ? { origin: 'session' } : {}),
        // The PR panel routes into the hub's Pull Request segment via descriptor params.
        ...descriptor.params
      }
    })
  }

  const openAgentSessionHistory = () => {
    const params = new URLSearchParams({ name: worktreeName || '' })
    router.push(`/h/${hostId}/agent-history/${encodeURIComponent(worktreeId)}?${params.toString()}`)
  }
  const showAgentSessionHistoryAction =
    !isFolderWorkspaceRoute && !isFloatingWorkspaceRoute && agentSessionHistorySupported === true
  const showChecksAction = shouldShowSessionHeaderChecksAction({
    isFolderWorkspaceRoute: isFolderWorkspaceRoute || isFloatingWorkspaceRoute,
    repoContextLoaded: prRepoContextLoaded,
    hostedChecksSupported: prIsGithubRepo
  })
  const showHeaderMoreButton = showAgentSessionHistoryAction || showChecksAction
  const createTabBusy = creating || creatingBrowser || creatingMarkdown
  return {
    createTabAgentActions,
    sendDiffNotesAgentActions,
    handleSessionContentRowLayout,
    handlePanelTap,
    openAgentSessionHistory,
    showAgentSessionHistoryAction,
    showChecksAction,
    showHeaderMoreButton,
    createTabBusy
  }
}

export type MobileSessionPanelRouteActionsModel = MobileSessionPresentationModel &
  ReturnType<typeof useMobileSessionPanelRouteActions>
