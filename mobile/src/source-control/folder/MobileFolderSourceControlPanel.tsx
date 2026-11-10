import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { GitBranch } from 'lucide-react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../../components/MobileStateView'
import { connectionRetryAction } from '../../transport/connection/connection-retry-action'
import { useForceReconnect } from '../../transport/connection/host-client-hooks'
import { OptionPager, useOptionPager } from '../../components/bottom-drawer/BottomDrawer'
import { ListGroup } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useWorkspaceRouteHandoff } from '../../navigation/workspace-route-handoff'
import { WorkspaceExecutionScope } from '../../navigation/workspace-route'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { FolderListRow } from './mobile-folder-attached-worktrees'
import { getWorktreeRowIdentity } from '../../worktree/worktree-host-row-identity'
import { MobileSourceControlHeader } from '../MobileSourceControlHeader'
import { MobileSourceControlPanel } from '../MobileSourceControlPanel'
import { styles as sourceControlStyles } from '../mobile-source-control-styles'
import { MobileFolderEmptyState } from './MobileFolderEmptyState'
import { useFolderCreateFlow } from './use-folder-create-flow'
import { MobileFolderWorktreeRow } from './MobileFolderWorktreeRow'
import { useOptionalHostProtocolGates } from '../../components/host-protocol-gates-context'
import { useMobileFolderAttachedWorktrees } from './use-mobile-folder-attached-worktrees'

const NO_CAPABILITIES: readonly string[] = []

type Props = {
  hostId: string
  folderWorktreeId: string
  name: string
  embedded: boolean
  onRequestClose?: () => void
}

/** A folder workspace's Source Control: one row per attached worktree, each opening that worktree's own Source Control in place. */
export function MobileFolderSourceControlPanel({
  hostId,
  folderWorktreeId,
  name,
  embedded,
  onRequestClose
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useWorkspaceRouteHandoff()
  const insets = useSafeAreaInsets()
  const pager = useOptionPager<string>()
  const [opened, setOpened] = useState<FolderListRow | null>(null)
  const pageOpen = pager.page !== null
  // A covered screen stops observing, as the single-worktree screen does, and so does the list under an open child.
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const observing = focused && !pageOpen
  const { folder, worktrees, desktopCapabilities, serverHosts, connState, loadError, refetch } =
    useMobileFolderAttachedWorktrees(hostId, folderWorktreeId, observing)
  // In a server's scope these are the server's own; otherwise the desktop's.
  const folderHostGates = useOptionalHostProtocolGates()
  const forceReconnect = useForceReconnect()
  const [refreshers] = useState(() => new Set<() => void>())
  const createFlow = useFolderCreateFlow({
    hostId,
    folderWorktreeId,
    executionHost: folder?.hostId?.startsWith('runtime:') ? folder.hostId : undefined,
    desktopCapabilities,
    members: worktrees,
    observing,
    refetch,
    bottomInset: insets.bottom
  })
  // Rows and repositories under a create form wait; the folder's members stay live so creates still reconcile.
  const statusObserving = observing && !createFlow.covered
  const refresh = () => {
    refetch()
    for (const refreshNow of refreshers) {
      refreshNow()
    }
  }
  useBackClaim(
    pageOpen
      ? () => {
          pager.close()
          return true
        }
      : null
  )
  const openPage = pager.open
  const open = useCallback(
    (worktree: FolderListRow) => {
      setOpened(worktree)
      openPage(getWorktreeRowIdentity(worktree))
    },
    [openPage]
  )
  const onClose = onRequestClose ?? (() => router.back())

  const header = (
    <MobileSourceControlHeader
      embedded={embedded}
      worktreeLabel={folder?.displayName || name}
      ioBusy={false}
      refreshing={false}
      onBack={() => router.back()}
      onClose={onClose}
      onRefresh={refresh}
    />
  )
  const retry = connectionRetryAction({
    hostId,
    needsReconnect: connState !== 'connected',
    forceReconnect,
    reload: refetch
  })
  const body =
    // A connection still coming up shows loading; offline is for one that dropped or was refused.
    folder === undefined && (connState === 'disconnected' || connState === 'auth-failed') ? (
      <MobileOfflineState onReconnect={retry} />
    ) : folder === undefined && loadError ? (
      <MobileLoadErrorState error={loadError} onRetry={retry} />
    ) : folder === undefined ? (
      <MobileStateView loading title={t('sourceControl.panel.loading', 'Loading changes…')} />
    ) : folder === null ? (
      <MobileStateView
        icon={GitBranch}
        title={t('sourceControl.panel.unavailableTitle', 'Source Control Unavailable')}
      />
    ) : worktrees.length === 0 ? (
      <MobileFolderEmptyState
        hostId={hostId}
        folder={folder}
        desktopCapabilities={desktopCapabilities}
        folderHostCapabilities={folderHostGates?.hostCapabilities ?? NO_CAPABILITIES}
        observing={statusObserving}
        refreshers={refreshers}
        onCreate={(repo, target, client, createName) =>
          void createFlow.onCreate(repo, target, client, createName)
        }
        bottomInset={insets.bottom}
      />
    ) : (
      // One card per attached worktree, as desktop shows them.
      <ScrollView
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.lg }]}
      >
        {worktrees.map((worktree) => (
          <ListGroup key={getWorktreeRowIdentity(worktree)}>
            <MobileFolderWorktreeRow
              hostId={hostId}
              desktopCapabilities={desktopCapabilities}
              worktree={worktree}
              unreachable={
                serverHosts.find((server) => server.hostId === worktree.hostId)?.relay ===
                'update-needed'
              }
              subscribed={statusObserving}
              refreshers={refreshers}
              onOpen={open}
            />
          </ListGroup>
        ))}
      </ScrollView>
    )
  const main = (
    <View style={sourceControlStyles.container}>
      {embedded ? (
        <View style={sourceControlStyles.header}>{header}</View>
      ) : (
        <SafeAreaView style={sourceControlStyles.header} edges={['top']}>
          {header}
        </SafeAreaView>
      )}
      {/* Every state shares the sheet surface the cards sit on, as the phone's option sheets do. */}
      <View style={styles.body}>{body}</View>
      {createFlow.toastElement}
      {createFlow.composerElement}
    </View>
  )
  return (
    <OptionPager
      fill
      pager={pager}
      main={main}
      page={
        pageOpen && opened ? (
          // The worktree's own Source Control, on its own server when the desktop relays one.
          <WorkspaceExecutionScope
            hostId={hostId}
            executionHost={opened.hostId?.startsWith('runtime:') ? opened.hostId : undefined}
          >
            <MobileSourceControlPanel
              key={getWorktreeRowIdentity(opened)}
              hostId={hostId}
              worktreeId={opened.worktreeId}
              name={opened.displayName || opened.repo}
              embedded={embedded}
              backInPlace={{
                onPress: pager.close,
                label: t('sourceControl.folder.backToFolder', 'Back to folder')
              }}
              onRequestClose={onRequestClose}
            />
          </WorkspaceExecutionScope>
        ) : null
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
  body: {
    flex: 1,
    backgroundColor: colors.sheetSurface
  },
  list: {
    padding: spacing.lg,
    gap: spacing.sm
  }
}))
