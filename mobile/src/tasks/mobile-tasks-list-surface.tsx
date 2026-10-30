import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  View,
  Text,
  ActivityIndicator,
  colors,
  TaskProviderLogo,
  Pressable,
  type MobileColorScheme
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { renderMobileTasksGitHubProjectList } from './mobile-tasks-github-project-list'
import { renderMobileTasksLinearList } from './mobile-tasks-linear-list'
import { renderMobileTasksProviderItemList } from './mobile-tasks-provider-item-list'
import { JiraConnectPrompt } from '../components/JiraConnectPrompt'

export function renderMobileTasksListSurface(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme
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
    tasksSupported,
    tasksUnsupported
  } = model
  return !tasksSupported ? (
    tasksUnsupported ? (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {translate('tasks.listSurface.updateDesktopTitle', 'Update Orca desktop')}
        </Text>
        <Text style={styles.centeredHint}>
          {translate(
            'tasks.listSurface.updateDesktopMessage',
            'This mobile Tasks view needs a newer desktop runtime.'
          )}
        </Text>
      </View>
    ) : (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  ) : provider === 'jira' && !jiraConnection.connected ? (
    <JiraConnectPrompt
      credentialError={jiraConnection.credentialError}
      unavailableReason={jiraConnection.unavailableReason}
      disabled={!taskUiReady}
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
    <View style={styles.centered}>
      <TaskProviderLogo provider="linear" size={32} color={colors.textSecondary} />
      <Text style={styles.emptyText}>
        {translate('tasks.listSurface.connectLinearTitle', 'Connect your Linear account')}
      </Text>
      <Text style={styles.centeredHint}>
        {translate(
          'tasks.listSurface.connectLinearMessage',
          'Browse and start work on your assigned Linear issues directly from Tasks.'
        )}
      </Text>
      <Pressable
        style={[styles.targetButton, styles.centerActionButton]}
        disabled={!taskUiReady}
        onPress={() => {
          if (!taskUiReady) {
            return
          }
          setLinearApiKeyDraft('')
          setLinearConnectState('idle')
          setLinearConnectError('')
          setShowLinearConnect(true)
        }}
      >
        <Text style={styles.targetButtonText}>
          {translate('tasks.listSurface.connectLinearButton', 'Connect Linear')}
        </Text>
      </Pressable>
    </View>
  ) : provider === 'github' && githubMode === 'project' ? (
    renderMobileTasksGitHubProjectList(model, colorScheme)
  ) : (
    renderMobileTasksNonProjectLists(model, colorScheme)
  )
}

export function renderMobileTasksNonProjectLists(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme
) {
  const { provider } = model
  return provider === 'linear'
    ? renderMobileTasksLinearList(model, colorScheme)
    : renderMobileTasksProviderItemList(model, colorScheme)
}
