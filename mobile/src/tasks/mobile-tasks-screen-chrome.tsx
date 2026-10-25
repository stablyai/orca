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

const REFRESH_LABELS = {
  github: 'Refresh GitHub work',
  gitlab: 'Refresh GitLab work items',
  linear: 'Refresh Linear',
  jira: 'Refresh Jira issues'
} as const

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
        accessibilityLabel="Back"
      >
        <ChevronLeft size={22} color={colors.textPrimary} />
      </Pressable>
      <View style={styles.titleWrap}>
        <View style={styles.titleLine}>
          <StatusDot state={connState} verdict={headerVerdict} />
          <Text style={styles.title}>Tasks</Text>
        </View>
        <MobileTasksHostSubtitle hostId={hostId} />
      </View>
      <Pressable
        style={styles.iconButton}
        disabled={!taskUiReady || loading || refreshing || githubProjectLoading}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={REFRESH_LABELS[provider]}
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
              ? 'New GitHub issue'
              : linearConnected
                ? 'New Linear issue'
                : 'Connect Linear'
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
