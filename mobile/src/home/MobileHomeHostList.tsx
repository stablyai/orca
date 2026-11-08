import { Plus } from 'lucide-react-native'
import { Fragment, memo, useCallback } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { classifyConnection } from '../transport/connection/connection-health'
import { resolveHomeHostConnectionState } from '../transport/hosts/home-host-auto-connect'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { HostCatalogEntry } from '../transport/hosts/host-profile'
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'
import type { HomeHostConnections } from './home-host-connection-projection'
import { homeListStyles } from './home-list-styles'
import { MobileHomeDesktopRow } from './MobileHomeDesktopRow'
import { MobileHomeSectionHeading } from './MobileHomeSectionHeading'

type MobileHomeHostListProps = {
  autoConnectHostIds: string[]
  first: boolean
  hostAttempts: Record<string, number>
  hostLastConnected: Record<string, number | null>
  hostConnections: HomeHostConnections
  hosts: HostCatalogEntry[]
  hostStates: Record<string, ConnectionState>
  worktreeInfo: Record<string, HostWorktreeInfo>
  onOpen: (host: HostCatalogEntry) => void
  onOpenActions: (host: HostCatalogEntry) => void
  onPairDesktop: () => void
}

/** Home's Desktops section: one row per paired desktop, then "Pair a desktop". */
export function MobileHomeHostList(props: MobileHomeHostListProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <MobileHomeSectionHeading
        title={t('home.listHeader.desktopsHeading', 'Desktops')}
        first={props.first}
      />
      <View style={homeListStyles.group}>
        {props.hosts.map((host, index) => (
          <Fragment key={host.id}>
            <MobileHomeHostRow
              item={host}
              autoConnectHostIds={props.autoConnectHostIds}
              hostAttempts={props.hostAttempts}
              hostLastConnected={props.hostLastConnected}
              hostConnections={props.hostConnections}
              hostStates={props.hostStates}
              worktreeInfo={props.worktreeInfo}
              onOpen={props.onOpen}
              onOpenActions={props.onOpenActions}
            />
            <View
              style={[
                homeListStyles.separator,
                homeListStyles.tileSeparator,
                index === props.hosts.length - 1 && homeListStyles.fullSeparator
              ]}
            />
          </Fragment>
        ))}
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [homeListStyles.actionRow, pressed && homeListStyles.rowPressed]}
          onPress={props.onPairDesktop}
        >
          <Plus size={18} color={colors.accentBlue} />
          <Text style={homeListStyles.actionLabel}>
            {t('home.desktops.pairDesktop', 'Pair a desktop')}
          </Text>
        </Pressable>
      </View>
    </>
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
  | 'onOpenActions'
> & { item: HostCatalogEntry }

const MobileHomeHostRow = memo(function MobileHomeHostRow(props: MobileHomeHostRowProps) {
  const { item, onOpen, onOpenActions } = props
  const state = resolveHomeHostConnectionState(
    item.id,
    props.hostStates[item.id],
    props.autoConnectHostIds
  )
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
  const openActions = useCallback(() => onOpenActions(item), [item, onOpenActions])

  return (
    <MobileHomeDesktopRow
      host={item}
      credentialStatus={item.credentialStatus}
      state={state}
      verdict={verdict}
      path={connection?.path ?? 'lan'}
      worktreeInfo={props.worktreeInfo[item.id]}
      onPress={open}
      onLongPress={openActions}
    />
  )
})
