import { useRef, useState } from 'react'
import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { NavBar } from '../../components/nav-bar/NavBar'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { View } from 'react-native'
import { ChevronLeft, Ellipsis, RefreshCw } from 'lucide-react-native'
import { StatusDot } from '../../components/feedback/StatusDot'
import { MobileTasksHostSubtitle } from './mobile-tasks-host-subtitle'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useRefreshHint } from '../../query/refresh-hint'

// Back, Tasks and ⋯ only: filters live in the bar's filter sheet, search at the bottom.
export function renderMobileTasksChrome(model: ConnectionPresentationModel) {
  return (
    <View ref={model.setTaskCopyFeedbackRootRef} style={model.styles.topChrome}>
      <MobileTasksNavBar model={model} />
    </View>
  )
}

function MobileTasksNavBar({ model }: { model: ConnectionPresentationModel }) {
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
    revalidating,
    router,
    taskUiReady
  } = model
  const t = useMobileTranslation()
  const showRefreshLine = useRefreshHint(revalidating)
  const menuAnchor = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
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
            ref={menuAnchor}
            icon={Ellipsis}
            accessibilityLabel={t('tasks.screenChrome.more', 'More')}
            onPress={() => setMenuOpen(true)}
          />
        }
        refreshing={showRefreshLine}
      />
      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuAnchor}
        onClose={() => setMenuOpen(false)}
        groups={[
          [
            {
              label: t('common.refresh', 'Refresh'),
              icon: RefreshCw,
              // The page's lists can't be pulled to refresh in the WebView, so this is the way to re-read.
              disabled: !taskUiReady || loading || refreshing || githubProjectLoading,
              onPress: () => {
                if (provider === 'github' && githubMode === 'project') {
                  refreshGitHubProject()
                  return
                }
                refreshTasks()
              }
            }
          ]
        ]}
      />
    </>
  )
}
