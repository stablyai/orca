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
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  useWorkspaceExecutionHost,
  workspaceRouteHref,
  workspaceRouteParams
} from '../navigation/workspace-execution-host'
import type { MobileSessionPresentationModel } from './use-mobile-session-presentation'

export function useMobileSessionPanelRouteActions(scope: MobileSessionPresentationModel) {
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
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
    sendDiffNotesToNewAgent,
    handleCreateTerminal,
    setCreateError,
    setShowQuickCommands,
    quickCommandsSupported,
    showToast
  } = scope
  const otherRuntimeAgentRow = {
    id: 'otherServerAgents',
    label: t('session.usePanelRouteActions.otherServerAgents', 'Agents on Another Server'),
    hint: t('session.usePanelRouteActions.pairServerHint', 'Pair that server directly'),
    icon: Bot,
    disabled: true,
    onPress: () => {}
  }
  const createTabAgentActions =
    createTabAgentLoadState === 'loading'
      ? [
          {
            id: 'detectingAgents',
            label: t('session.usePanelRouteActions.detectingAgents', 'Detecting Agents'),
            icon: Bot,
            disabled: true,
            loading: true,
            onPress: () => {}
          }
        ]
      : createTabAgentOptions.length > 0
        ? createTabAgentOptions.map((option) => ({
            id: `agent:${option.agent}`,
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
                id: 'noEnabledAgents',
                label: t('session.usePanelRouteActions.noEnabledAgents', 'No Enabled Agents'),
                icon: Bot,
                disabled: true,
                onPress: () => {}
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
                    hint: t(
                      'session.usePanelRouteActions.checkHostHint',
                      'Check the host connection'
                    ),
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
              id: 'detectingAgents',
              label: t('session.usePanelRouteActions.detectingAgents', 'Detecting Agents'),
              icon: Bot,
              disabled: true,
              loading: true,
              onPress: () => {}
            }
          ]
        : createTabAgentOptions.length > 0
          ? createTabAgentOptions.map((option) => ({
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
            }))
          : createTabAgentLoadState === 'loaded'
            ? [
                {
                  id: 'noEnabledAgents',
                  label: t('session.usePanelRouteActions.noEnabledAgents', 'No Enabled Agents'),
                  icon: Bot,
                  disabled: true,
                  onPress: () => {}
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
                      hint: t('session.usePanelRouteActions.copyNotesHint', 'Copy notes instead'),
                      icon: Bot,
                      disabled: true,
                      onPress: () => {}
                    }
                  ]
                : []

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
    createTabBusy,
    handleOpenNewTab,
    handleOpenQuickCommands
  }
}

export type MobileSessionPanelRouteActionsModel = MobileSessionPresentationModel &
  ReturnType<typeof useMobileSessionPanelRouteActions>
