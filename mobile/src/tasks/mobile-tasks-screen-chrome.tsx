import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  View,
  Pressable,
  ChevronLeft,
  colors,
  StatusDot,
  Text,
  RefreshCw,
  Plus
} from './mobile-tasks-dependencies'
import { MobileTasksHostSubtitle } from './mobile-tasks-host-subtitle'
import { styles } from './mobile-tasks-legacy-styles'
import { renderMobileTasksProviderControls } from './mobile-tasks-provider-controls'
import { renderMobileTasksSearchControl } from './mobile-tasks-search-control'
import { translate } from '../i18n/mobile-i18n'

function refreshLabels() {
  return {
    github: translate('tasks.screenChrome.refreshGitHub', 'Refresh GitHub work'),
    gitlab: translate('tasks.screenChrome.refreshGitLab', 'Refresh GitLab work items'),
    linear: translate('tasks.screenChrome.refreshLinear', 'Refresh Linear'),
    jira: translate('tasks.screenChrome.refreshJira', 'Refresh Jira issues')
  }
}

export function renderMobileTasksChrome(model: ConnectionPresentationModel) {
  const { setTaskCopyFeedbackRootRef } = model
  return (
    <View ref={setTaskCopyFeedbackRootRef} style={styles.topChrome}>
      {renderMobileTasksStatusBar(model)}

      {renderMobileTasksProviderControls(model)}

      {renderMobileTasksSearchControl(model)}
    </View>
  )
}

export function renderMobileTasksStatusBar(model: ConnectionPresentationModel) {
  const {
    connState,
    githubMode,
    githubProjectLoading,
    headerVerdict,
    hostId,
    linearConnected,
    loading,
    provider,
    refreshGitHubProject,
    refreshTasks,
    refreshing,
    router,
    setCreateBody,
    setCreateTitle,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setShowCreateTask,
    setShowLinearConnect,
    showHeaderCreateTask,
    taskUiReady
  } = model
  return (
    <View style={styles.statusBar}>
      <Pressable
        style={styles.backButton}
        onPress={() => router.back()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={translate('common.back', 'Back')}
      >
        <ChevronLeft size={22} color={colors.textPrimary} />
      </Pressable>
      <View style={styles.titleWrap}>
        <View style={styles.titleLine}>
          <StatusDot state={connState} verdict={headerVerdict} />
          <Text style={styles.title}>{translate('tasks.screenChrome.title', 'Tasks')}</Text>
        </View>
        <MobileTasksHostSubtitle hostId={hostId} />
      </View>
      <Pressable
        style={styles.iconButton}
        disabled={!taskUiReady || loading || refreshing || githubProjectLoading}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={refreshLabels()[provider]}
        onPress={() => {
          if (!taskUiReady) {
            return
          }
          if (provider === 'github' && githubMode === 'project') {
            refreshGitHubProject()
            return
          }
          refreshTasks()
        }}
      >
        <RefreshCw size={16} color={taskUiReady ? colors.textSecondary : colors.textMuted} />
      </Pressable>
      {showHeaderCreateTask ? (
        <Pressable
          style={styles.iconButton}
          disabled={!taskUiReady}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            provider === 'github'
              ? translate('tasks.screenChrome.newGitHubIssue', 'New GitHub issue')
              : linearConnected
                ? translate('tasks.screenChrome.newLinearIssue', 'New Linear issue')
                : translate('tasks.screenChrome.connectLinear', 'Connect Linear')
          }
          onPress={() => {
            if (!taskUiReady) {
              return
            }
            if (provider === 'linear' && !linearConnected) {
              setLinearApiKeyDraft('')
              setLinearConnectState('idle')
              setLinearConnectError('')
              setShowLinearConnect(true)
              return
            }
            setCreateTitle('')
            setCreateBody('')
            setShowCreateTask(true)
          }}
        >
          <Plus size={16} color={taskUiReady ? colors.textSecondary : colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  )
}
