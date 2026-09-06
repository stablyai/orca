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
import { styles } from './mobile-tasks-legacy-styles'
import { renderMobileTasksProviderControls } from './mobile-tasks-provider-controls'
import { renderMobileTasksSearchControl } from './mobile-tasks-search-control'

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
      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <ChevronLeft size={22} color={colors.textPrimary} />
      </Pressable>
      <View style={styles.titleWrap}>
        <StatusDot state={connState} verdict={headerVerdict} />
        <Text style={styles.title}>Tasks</Text>
      </View>
      <Pressable
        style={styles.iconButton}
        disabled={!taskUiReady || loading || refreshing || githubProjectLoading}
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
