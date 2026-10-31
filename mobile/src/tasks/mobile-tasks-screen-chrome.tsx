import type { ReactNode } from 'react'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { View, ChevronLeft, StatusDot, RefreshCw } from './mobile-tasks-dependencies'
import { MobileTasksHostSubtitle } from './mobile-tasks-host-subtitle'
import { styles } from './mobile-tasks-legacy-styles'
import { renderMobileTasksProviderControls } from './mobile-tasks-provider-controls'
import { selectMobileTasksProvider } from './mobile-tasks-provider-pickers'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

function refreshLabels(t: Translate) {
  return {
    github: t('tasks.screenChrome.refreshGitHub', 'Refresh GitHub work'),
    gitlab: t('tasks.screenChrome.refreshGitLab', 'Refresh GitLab work items'),
    linear: t('tasks.screenChrome.refreshLinear', 'Refresh Linear'),
    jira: t('tasks.screenChrome.refreshJira', 'Refresh Jira issues')
  }
}

// Bar, then the source switch, then one row of scope chips; search and New task sit at the bottom.
export function renderMobileTasksChrome(model: ConnectionPresentationModel) {
  const { provider, providerOptions, setTaskCopyFeedbackRootRef, taskUiReady } = model
  return (
    <View ref={setTaskCopyFeedbackRootRef} style={styles.topChrome}>
      <MobileTasksStatusBar
        model={model}
        accessory={
          <>
            {providerOptions.length > 1 ? (
              <MobileSegmentedControl
                segments={providerOptions}
                selected={provider}
                onSelect={(next) => {
                  if (next !== provider) {
                    selectMobileTasksProvider(model, next)
                  }
                }}
                disabled={!taskUiReady}
                fill
                testIDPrefix="mobile-tasks-provider-"
                style={styles.providerSwitch}
              />
            ) : null}

            {renderMobileTasksProviderControls(model)}
          </>
        }
      />
    </View>
  )
}

// These pages have no pull-to-refresh, so Refresh stays in the bar.
export function MobileTasksStatusBar({
  model,
  accessory
}: {
  model: ConnectionPresentationModel
  accessory: ReactNode
}) {
  const {
    connState,
    githubMode,
    githubProjectLoading,
    headerVerdict,
    hostId,
    loading,
    provider,
    refreshGitHubProject,
    refreshTasks,
    refreshing,
    router,
    taskUiReady
  } = model
  const t = useMobileTranslation()
  return (
    <NavBar
      leading={
        <NavBarButton
          icon={ChevronLeft}
          onPress={() => router.back()}
          accessibilityLabel={t('common.back', 'Back')}
        />
      }
      title={t('tasks.screenChrome.title', 'Tasks')}
      subtitle={
        <>
          <StatusDot state={connState} verdict={headerVerdict} />
          <MobileTasksHostSubtitle hostId={hostId} />
        </>
      }
      trailing={
        <NavBarButton
          icon={RefreshCw}
          accessibilityLabel={refreshLabels(t)[provider]}
          disabled={!taskUiReady || loading || refreshing || githubProjectLoading}
          onPress={() => {
            if (provider === 'github' && githubMode === 'project') {
              refreshGitHubProject()
              return
            }
            refreshTasks()
          }}
        />
      }
      accessory={accessory}
    />
  )
}
