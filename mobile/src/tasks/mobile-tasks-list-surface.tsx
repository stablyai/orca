import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { colors, TaskProviderLogo, type MobileColorScheme } from './mobile-tasks-dependencies'
import { renderMobileTasksGitHubProjectList } from './mobile-tasks-github-project-list'
import { renderMobileTasksLinearList } from './mobile-tasks-linear-list'
import { renderMobileTasksProviderItemList } from './mobile-tasks-provider-item-list'
import { JiraConnectPrompt } from '../components/JiraConnectPrompt'
import { MobileStateView } from '../components/MobileStateView'
import { renderMobileTasksSupportState } from './mobile-tasks-list-state'

export function renderMobileTasksListSurface(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme,
  bottomBarHeight: number
) {
  const {
    githubMode,
    linearConnected,
    jiraConnection,
    refreshJiraConnection,
    setError,
    provider,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setShowLinearConnect,
    taskUiReady,
    tasksSupported
  } = model
  return !tasksSupported ? (
    renderMobileTasksSupportState(model, bottomBarHeight)
  ) : provider === 'jira' && !jiraConnection.connected ? (
    <JiraConnectPrompt
      credentialError={jiraConnection.credentialError}
      unavailableReason={jiraConnection.unavailableReason}
      disabled={!taskUiReady}
      bottomInset={bottomBarHeight}
      onCheckAgain={() => {
        void refreshJiraConnection().catch((err: unknown) => {
          setError(
            err instanceof Error
              ? err.message
              : translate('tasks.listSurface.jiraStatusFailed', 'Failed to read Jira status')
          )
        })
      }}
    />
  ) : provider === 'linear' && !linearConnected ? (
    <MobileStateView
      iconElement={<TaskProviderLogo provider="linear" size={24} color={colors.textMuted} />}
      title={translate('tasks.listSurface.connectLinearTitle', 'Connect your Linear account')}
      message={translate(
        'tasks.listSurface.connectLinearMessage',
        'Browse and start work on your assigned Linear issues directly from Tasks.'
      )}
      action={
        taskUiReady
          ? {
              label: translate('tasks.listSurface.connectLinearButton', 'Connect Linear'),
              onPress: () => {
                setLinearApiKeyDraft('')
                setLinearConnectState('idle')
                setLinearConnectError('')
                setShowLinearConnect(true)
              }
            }
          : null
      }
      bottomInset={bottomBarHeight}
    />
  ) : provider === 'github' && githubMode === 'project' ? (
    renderMobileTasksGitHubProjectList(model, colorScheme, bottomBarHeight)
  ) : (
    renderMobileTasksNonProjectLists(model, colorScheme, bottomBarHeight)
  )
}

export function renderMobileTasksNonProjectLists(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme,
  bottomBarHeight: number
) {
  const { provider } = model
  return provider === 'linear'
    ? renderMobileTasksLinearList(model, colorScheme, bottomBarHeight)
    : renderMobileTasksProviderItemList(model, colorScheme, bottomBarHeight)
}
