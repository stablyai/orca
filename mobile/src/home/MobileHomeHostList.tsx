import { memo, useCallback, type ReactElement } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import type { ListRenderItemInfo } from 'react-native'
import { MobileHostCard } from '../components/MobileHostCard'
import type { HomeStatsSummary } from '../stats/home-stats-total'
import { spacing } from '../theme/mobile-theme'
import { classifyConnection } from '../transport/connection-health'
import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import type { MobileConnectionPath } from '../transport/stable-logical-rpc-client'
import type { ConnectionState, HostCatalogEntry } from '../transport/types'
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'
import { MobileHomeListHeader } from './MobileHomeListHeader'

type MobileHomeHostListProps = {
  autoConnectHostIds: string[]
  bottomInset: number
  contentMaxWidth: number
  footer: ReactElement
  hostAttempts: Record<string, number>
  hostLastConnected: Record<string, number | null>
  hostPairingRejected: Record<string, boolean>
  hostPaths: Record<string, MobileConnectionPath>
  hostPendingPaths: Record<string, MobileConnectionPath | null>
  hosts: HostCatalogEntry[]
  hostStates: Record<string, ConnectionState>
  isWideLayout: boolean
  stats: HomeStatsSummary | null
  worktreeInfo: Record<string, HostWorktreeInfo>
  onOpen: (host: HostCatalogEntry) => void
  onLongPress: (host: HostCatalogEntry) => void
  onOpenActions: (host: HostCatalogEntry) => void
}

export function MobileHomeHostList(props: MobileHomeHostListProps) {
  const renderHost = useCallback(
    ({ item }: ListRenderItemInfo<HostCatalogEntry>) => (
      <MobileHomeHostRow
        item={item}
        autoConnectHostIds={props.autoConnectHostIds}
        hostAttempts={props.hostAttempts}
        hostLastConnected={props.hostLastConnected}
        hostPairingRejected={props.hostPairingRejected}
        hostPaths={props.hostPaths}
        hostPendingPaths={props.hostPendingPaths}
        hostStates={props.hostStates}
        worktreeInfo={props.worktreeInfo}
        onOpen={props.onOpen}
        onLongPress={props.onLongPress}
        onOpenActions={props.onOpenActions}
      />
    ),
    [
      props.autoConnectHostIds,
      props.hostAttempts,
      props.hostLastConnected,
      props.hostPairingRejected,
      props.hostPaths,
      props.hostPendingPaths,
      props.hostStates,
      props.onLongPress,
      props.onOpen,
      props.onOpenActions,
      props.worktreeInfo
    ]
  )

  return (
    <FlatList
      data={props.hosts}
      keyExtractor={(host) => host.id}
      contentContainerStyle={[
        styles.list,
        { paddingBottom: spacing.xl + props.bottomInset },
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
      ListHeaderComponent={<MobileHomeListHeader stats={props.stats} />}
      ItemSeparatorComponent={CardGap}
      renderItem={renderHost}
      ListFooterComponent={props.footer}
    />
  )
}

type MobileHomeHostRowProps = Pick<
  MobileHomeHostListProps,
  | 'autoConnectHostIds'
  | 'hostAttempts'
  | 'hostLastConnected'
  | 'hostPairingRejected'
  | 'hostPaths'
  | 'hostPendingPaths'
  | 'hostStates'
  | 'worktreeInfo'
  | 'onOpen'
  | 'onLongPress'
  | 'onOpenActions'
> & { item: HostCatalogEntry }

const MobileHomeHostRow = memo(function MobileHomeHostRow(props: MobileHomeHostRowProps) {
  const { item, onLongPress, onOpen, onOpenActions } = props
  const state = resolveHomeHostConnectionState(
    item.id,
    props.hostStates[item.id],
    props.autoConnectHostIds
  )
  const verdict = classifyConnection({
    state,
    reconnectAttempts: props.hostAttempts[item.id] ?? 0,
    lastConnectedAt: props.hostLastConnected[item.id] ?? null,
    endpoint: item.endpoint,
    pendingPath: props.hostPendingPaths[item.id] ?? null,
    pairingRejected: props.hostPairingRejected[item.id] ?? false
  })
  const open = useCallback(() => onOpen(item), [item, onOpen])
  const longPress = useCallback(() => onLongPress(item), [item, onLongPress])
  const openActions = useCallback(() => onOpenActions(item), [item, onOpenActions])

  return (
    <MobileHostCard
      host={item}
      credentialStatus={item.credentialStatus}
      state={state}
      verdict={verdict}
      path={props.hostPaths[item.id] ?? 'lan'}
      worktreeInfo={props.worktreeInfo[item.id]}
      onPress={open}
      onLongPress={longPress}
      onOpenActions={openActions}
    />
  )
})

function CardGap() {
  return <View style={styles.cardGap} />
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  cardGap: { height: spacing.sm }
})
