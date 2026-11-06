import { CircleAlert, Inbox } from 'lucide-react-native'
import {
  MobileLoadErrorState,
  MobileNoMatchState,
  MobileOfflineState,
  MobileStateView
} from '../components/MobileStateView'
import { useForceReconnect } from '../transport/host-client-hooks'
import { translate } from '../i18n/mobile-i18n'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { clearMobileTasksSearch } from './mobile-tasks-search-control'

/** True when the list body itself shows the load failure, so the banner above must not repeat it. */
export function mobileTasksListShowsError(model: ConnectionPresentationModel): boolean {
  if (!model.error) {
    return false
  }
  if (!model.tasksSupported) {
    return true
  }
  if (model.loading) {
    return false
  }
  if (model.provider === 'github' && model.githubMode === 'project') {
    return false
  }
  return model.provider === 'linear'
    ? model.linearConnected && model.linearIssuesForView.length === 0
    : model.sortedItems.length === 0
}

/** The task list's loading, failed, no-match and empty bodies; null once there are rows to draw. */
export function renderMobileTasksListState(
  model: ConnectionPresentationModel,
  itemCount: number,
  bottomBarHeight: number
) {
  if (model.loading) {
    return (
      <MobileStateView
        loading
        title={translate('tasks.listState.loading', 'Loading tasks…')}
        bottomInset={bottomBarHeight}
      />
    )
  }
  if (itemCount > 0) {
    return null
  }
  // A failed read must not pass for an empty list.
  if (model.error) {
    return (
      <MobileLoadErrorState
        error={model.error}
        onRetry={() => void model.refreshTasks()}
        bottomInset={bottomBarHeight}
      />
    )
  }
  if (model.hasSearch) {
    return (
      <MobileNoMatchState
        message={model.emptyLabel}
        onClear={() => clearMobileTasksSearch(model)}
        bottomInset={bottomBarHeight}
      />
    )
  }
  return <MobileStateView icon={Inbox} title={model.emptyLabel} bottomInset={bottomBarHeight} />
}

/** Before Tasks knows the host supports it: offline, a failed probe, an old desktop, or still checking. */
export function renderMobileTasksSupportState(
  model: ConnectionPresentationModel,
  bottomBarHeight: number
) {
  if (model.tasksUnsupported) {
    return (
      <MobileStateView
        icon={CircleAlert}
        title={translate('tasks.listSurface.updateDesktopTitle', 'Update Orca desktop')}
        message={translate(
          'tasks.listSurface.updateDesktopMessage',
          'This mobile Tasks view needs a newer desktop runtime.'
        )}
        bottomInset={bottomBarHeight}
      />
    )
  }
  if (model.connState !== 'connected') {
    return <MobileTasksOfflineState hostId={model.hostId} bottomInset={bottomBarHeight} />
  }
  if (model.error) {
    return (
      <MobileLoadErrorState
        error={model.error}
        onRetry={model.retryTasksHydration}
        bottomInset={bottomBarHeight}
      />
    )
  }
  return (
    <MobileStateView
      loading
      title={translate('tasks.listState.loading', 'Loading tasks…')}
      bottomInset={bottomBarHeight}
    />
  )
}

function MobileTasksOfflineState({ hostId, bottomInset }: { hostId: string; bottomInset: number }) {
  const forceReconnect = useForceReconnect()
  return (
    <MobileOfflineState
      onReconnect={forceReconnect && hostId ? () => void forceReconnect(hostId) : null}
      bottomInset={bottomInset}
    />
  )
}
