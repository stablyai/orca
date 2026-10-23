import { memo, useCallback, type ReactNode } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { Plus } from 'lucide-react-native'
import { MobileHostCard } from '../components/MobileHostCard'
import { ListGroup, LIST_LEADING_INSET, LIST_ROW_PADDING } from '../components/ui/ListGroup'
import { SectionHeader } from '../components/ui/SectionHeader'
import { pressTransition } from '../components/ui/transition-styles'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { classifyConnection } from '../transport/connection-health'
import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import { useHostStatusGates } from '../transport/host-status-gates'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostCatalogEntry } from '../transport/types'
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'
import type { HomeHostConnections } from './home-host-connection-projection'

type MobileHomeHostListProps = {
  autoConnectHostIds: string[]
  /** Room under the last group, so it clears the pinned bottom bar. */
  bottomPadding: number
  contentMaxWidth: number
  /** The title, summary and notices. */
  header: ReactNode
  /** Drawn before the desktops: "Needs you" and "Jump back in". */
  workspaces: ReactNode
  /** Drawn after the desktops: usage. */
  footer: ReactNode
  hostAttempts: Record<string, number>
  hostClients: Readonly<Record<string, RpcClient>>
  hostLastConnected: Record<string, number | null>
  hostConnections: HomeHostConnections
  hosts: HostCatalogEntry[]
  hostStates: Record<string, ConnectionState>
  isWideLayout: boolean
  worktreeInfo: Record<string, HostWorktreeInfo>
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  onOpen: (host: HostCatalogEntry) => void
  onLongPress: (host: HostCatalogEntry) => void
  onOpenActions: (host: HostCatalogEntry) => void
  onPairDesktop: () => void
}

/** Home's scrolling body: header, workspaces, the "Desktops" group with its pair row, then the footer. */
export function MobileHomeHostList(props: MobileHomeHostListProps) {
  return (
    <ScrollView
      onScroll={props.onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={[
        { paddingBottom: props.bottomPadding },
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
    >
      {props.header}
      {props.workspaces}
      <SectionHeader
        title="Desktops"
        count={props.hosts.length > 1 ? props.hosts.length : undefined}
      />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {props.hosts.map((item) => (
          <MobileHomeHostRow
            key={item.id}
            item={item}
            autoConnectHostIds={props.autoConnectHostIds}
            client={props.hostClients[item.id] ?? null}
            hostAttempts={props.hostAttempts}
            hostLastConnected={props.hostLastConnected}
            hostConnections={props.hostConnections}
            hostStates={props.hostStates}
            worktreeInfo={props.worktreeInfo}
            onOpen={props.onOpen}
            onLongPress={props.onLongPress}
            onOpenActions={props.onOpenActions}
          />
        ))}
        <PairDesktopRow onPress={props.onPairDesktop} />
      </ListGroup>
      {props.footer}
    </ScrollView>
  )
}

type MobileHomeHostRowProps = Pick<
  MobileHomeHostListProps,
  | 'autoConnectHostIds'
  | 'hostAttempts'
  | 'hostLastConnected'
  | 'hostConnections'
  | 'hostStates'
  | 'worktreeInfo'
  | 'onOpen'
  | 'onLongPress'
  | 'onOpenActions'
> & { item: HostCatalogEntry; client: RpcClient | null }

const MobileHomeHostRow = memo(function MobileHomeHostRow(props: MobileHomeHostRowProps) {
  const { item, onLongPress, onOpen, onOpenActions } = props
  const state = resolveHomeHostConnectionState(
    item.id,
    props.hostStates[item.id],
    props.autoConnectHostIds
  )
  // Why: the same status read the host screen's gate makes, so a desktop that would show the
  // update wall says "Update needed" here instead of "Connected".
  const { compatVerdict } = useHostStatusGates({
    hostId: item.id,
    client: props.client,
    connState: state
  })
  const connection = props.hostConnections[item.id]
  const verdict = classifyConnection({
    state,
    reconnectAttempts: props.hostAttempts[item.id] ?? 0,
    lastConnectedAt: props.hostLastConnected[item.id] ?? null,
    endpoint: item.endpoint,
    pendingPath: connection?.pendingPath ?? null,
    pairingRejected: connection?.pairingRejected ?? false,
    relayHostReachability: connection?.relayHostReachability ?? 'connecting',
    hostName: item.name
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
      path={connection?.path ?? 'lan'}
      worktreeInfo={props.worktreeInfo[item.id]}
      compatVerdict={compatVerdict}
      onPress={open}
      onLongPress={longPress}
      onOpenActions={openActions}
    />
  )
})

/** The Desktops group's last row: quieter than the desktops, and opens pairing. */
function PairDesktopRow({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Pair a desktop" onPress={onPress}>
      {({ pressed }) => (
        <View
          style={[
            styles.pairRow,
            pressed && styles.pairPressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View style={styles.pairLeading}>
            <Plus size={20} color={colors.textSecondary} strokeWidth={2} />
          </View>
          <Text style={styles.pairLabel} numberOfLines={1}>
            Pair a desktop
          </Text>
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  pairRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 10
  },
  pairPressed: { backgroundColor: colors.fill },
  pairLeading: { width: 28, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  pairLabel: { ...textStyles.body, color: colors.textSecondary, flex: 1, minWidth: 0 }
})
