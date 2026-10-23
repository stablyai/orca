import type { ReactNode } from 'react'
import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import { View, FlatList, Download, Plug, WifiOff } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { renderMobileTasksChrome } from './mobile-tasks-screen-chrome'
import { renderMobileTasksGitHubProjectList } from './mobile-tasks-github-project-list'
import { renderMobileTasksLinearList } from './mobile-tasks-linear-list'
import { renderMobileTasksProviderItemList } from './mobile-tasks-provider-item-list'
import { JiraConnectPrompt } from '../components/JiraConnectPrompt'
import { StateView } from '../components/ui/StateView'

const RECONNECTS_ON_ITS_OWN = 'Orca reconnects on its own when your desktop is awake and online.'

/**
 * A full-page state under the page header. A FlatList with no rows, like the lists themselves, so
 * moving between loading, empty and loaded keeps the header (and a focused search field) mounted.
 */
export function renderMobileTasksStatePage(model: PageChromeModel, state: ReactNode) {
  const { insets, onPageScroll } = model
  return (
    <FlatList
      style={styles.page}
      data={NO_ROWS}
      renderItem={() => null}
      ListHeaderComponent={renderMobileTasksChrome(model)}
      ListEmptyComponent={<View style={styles.stateBody}>{state}</View>}
      contentContainerStyle={[styles.statePage, { paddingBottom: insets.bottom }]}
      onScroll={onPageScroll}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
    />
  )
}

const NO_ROWS: readonly never[] = []

/** Connecting names its stage; a desktop that stays away says so and offers a retry. */
function renderMobileTasksConnectionState(model: PageChromeModel) {
  const { connState, headerVerdict, hostTitle, reconnectHost } = model
  const host = hostTitle?.trim() || 'your desktop'
  if (connState === 'connected') {
    return <StateView loading title="Loading tasks…" />
  }
  const escalated = headerVerdict.kind === 'warning' || headerVerdict.kind === 'unreachable'
  if (connState !== 'disconnected' && !escalated) {
    return <StateView loading title={`Connecting to ${host}…`} />
  }
  const detail = escalated ? headerVerdict.detail : undefined
  return (
    <StateView
      icon={WifiOff}
      title={escalated ? headerVerdict.label : `${hostTitle?.trim() || 'Desktop'} is offline`}
      message={detail ? `${detail}.` : RECONNECTS_ON_ITS_OWN}
      primary={reconnectHost ? { label: 'Try again', onPress: reconnectHost } : undefined}
    />
  )
}

export function renderMobileTasksListSurface(model: PageChromeModel) {
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
  if (!tasksSupported) {
    return renderMobileTasksStatePage(
      model,
      tasksUnsupported ? (
        <StateView
          icon={Download}
          title="Update Orca desktop"
          message="Tasks on your phone need a newer version of Orca on your desktop."
        />
      ) : (
        renderMobileTasksConnectionState(model)
      )
    )
  }
  if (provider === 'jira' && !jiraConnection.connected) {
    return renderMobileTasksStatePage(
      model,
      <JiraConnectPrompt
        credentialError={jiraConnection.credentialError}
        unavailableReason={jiraConnection.unavailableReason}
        disabled={!taskUiReady}
        onCheckAgain={() => {
          void refreshJiraConnection().catch((err: unknown) => {
            setError(err instanceof Error ? err.message : 'Failed to read Jira status')
          })
        }}
      />
    )
  }
  if (provider === 'linear' && !linearConnected) {
    return renderMobileTasksStatePage(
      model,
      <StateView
        icon={Plug}
        title="Connect your Linear account"
        message="Browse your Linear issues and start work on them from Tasks."
        primary={
          taskUiReady
            ? {
                label: 'Connect Linear',
                onPress: () => {
                  setLinearApiKeyDraft('')
                  setLinearConnectState('idle')
                  setLinearConnectError('')
                  setShowLinearConnect(true)
                }
              }
            : undefined
        }
      />
    )
  }
  return provider === 'github' && githubMode === 'project'
    ? renderMobileTasksGitHubProjectList(model)
    : renderMobileTasksNonProjectLists(model)
}

export function renderMobileTasksNonProjectLists(model: PageChromeModel) {
  const { provider } = model
  return provider === 'linear'
    ? renderMobileTasksLinearList(model)
    : renderMobileTasksProviderItemList(model)
}
