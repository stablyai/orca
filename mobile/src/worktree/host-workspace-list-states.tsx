import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  CircleAlert,
  FolderOpen,
  RefreshCw,
  SearchX,
  SlidersHorizontal,
  WifiOff
} from 'lucide-react-native'
import { Banner } from '../components/ui/Banner'
import { StateView } from '../components/ui/StateView'
import { spacing } from '../theme/mobile-theme'
import type { ConnectionVerdict } from '../transport/connection-health'
import {
  selectHostWorkspaceListState,
  type HostWorkspaceListStateInput
} from './host-workspace-list-state'

const RECONNECTS_ON_ITS_OWN = 'Orca reconnects on its own when your desktop is awake and online.'

type StateActions = {
  /** The desktop's name, for "Connecting to MacBook Pro…". */
  hostTitle?: string
  verdict?: ConnectionVerdict
  /** Re-dials the desktop; null where nothing here can (the page). */
  onRetry?: (() => void) | null
  onDiagnostics?: () => void
  onNewWorkspace?: () => void
  onClearFilters?: () => void
  onClearSearch?: () => void
}

export function HostWorkspaceListStates(
  props: HostWorkspaceListStateInput &
    StateActions & {
      search: string
      activeFilterCount: number
    }
) {
  const state = selectHostWorkspaceListState(props)
  const [showDetails, setShowDetails] = useState(false)
  if (state === 'loading') {
    return <LoadingOrOffline {...props} />
  }
  if (state === 'catalog-error') {
    return (
      <StateView
        icon={CircleAlert}
        title="Couldn't load workspaces"
        message={
          showDetails
            ? `Error: ${props.catalogError}. Orca keeps trying on its own.`
            : 'Orca keeps trying on its own.'
        }
        secondary={
          showDetails ? undefined : { label: 'Show details', onPress: () => setShowDetails(true) }
        }
      />
    )
  }
  if (state === 'empty') {
    if (props.search) {
      return (
        <StateView
          icon={SearchX}
          title="No results"
          message={`No workspace matches “${props.search}”.`}
          secondary={
            props.onClearSearch
              ? { label: 'Clear search', onPress: props.onClearSearch }
              : undefined
          }
        />
      )
    }
    if (props.activeFilterCount > 0) {
      return (
        <StateView
          icon={SlidersHorizontal}
          title="No workspaces match your filters"
          message="Change or clear the filters in Workspace options."
          secondary={
            props.onClearFilters
              ? { label: 'Clear filters', onPress: props.onClearFilters }
              : undefined
          }
        />
      )
    }
    return (
      <StateView
        icon={FolderOpen}
        title="No workspaces yet"
        message="Workspaces you create on this desktop show up here."
        secondary={
          props.onNewWorkspace
            ? { label: 'New workspace', onPress: props.onNewWorkspace }
            : undefined
        }
      />
    )
  }
  return null
}

/** Connecting names its stage; a desktop that stays away says so and offers a way forward. */
function LoadingOrOffline(props: HostWorkspaceListStateInput & StateActions) {
  const { connState, verdict, hostTitle } = props
  const host = hostTitle?.trim() || 'the desktop'
  if (connState === 'connected') {
    return <StateView loading title="Loading workspaces…" />
  }
  const away =
    connState === 'disconnected' || verdict?.kind === 'warning' || verdict?.kind === 'unreachable'
  if (!away) {
    return <StateView loading title={`Connecting to ${host}…`} />
  }
  const escalated = verdict && (verdict.kind === 'warning' || verdict.kind === 'unreachable')
  const message = !escalated
    ? RECONNECTS_ON_ITS_OWN
    : verdict.detail
      ? `${verdict.detail}.`
      : verdict.hint
        ? `${verdict.hint.charAt(0).toUpperCase()}${verdict.hint.slice(1)}, then try again.`
        : RECONNECTS_ON_ITS_OWN
  const retry = props.onRetry
  const diagnostics = props.onDiagnostics
  return (
    <StateView
      icon={WifiOff}
      title={escalated ? verdict.label : `${hostTitle?.trim() || 'Desktop'} is offline`}
      message={message}
      primary={retry ? { label: 'Try again', onPress: retry } : undefined}
      secondary={diagnostics ? { label: 'Diagnostics', onPress: diagnostics } : undefined}
    />
  )
}

/** A list this page cannot build; shown above the rows it already holds, so it never blanks. */
export function HostWorkspaceListReopen({ aboveRows }: { aboveRows: boolean }) {
  const message = 'This desktop lists workspaces in a way this page does not know yet.'
  if (aboveRows) {
    return (
      <View style={styles.aboveRows}>
        <Banner title="Reopen to update" message={message} />
      </View>
    )
  }
  return <StateView icon={RefreshCw} title="Reopen to update" message={message} />
}

const styles = StyleSheet.create({
  aboveRows: { paddingTop: spacing.sm, paddingBottom: spacing.xs }
})
