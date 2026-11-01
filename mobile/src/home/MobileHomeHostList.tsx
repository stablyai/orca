import { Plus } from 'lucide-react-native'
import { Fragment, memo, useCallback, type ReactElement } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { classifyConnection } from '../transport/connection-health'
import { resolveHomeHostConnectionState } from '../transport/home-host-auto-connect'
import type { ConnectionState, HostCatalogEntry } from '../transport/types'
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'
import type { HomeHostConnections } from './home-host-connection-projection'
import { homeListStyles } from './home-list-styles'
import { MobileHomeDesktopRow } from './MobileHomeDesktopRow'

type MobileHomeHostListProps = {
  autoConnectHostIds: string[]
  bottomInset: number
  contentMaxWidth: number
  /** Sections above Desktops (Jump back in); null when there's nothing to resume. */
  header: ReactElement | null
  /** Rows after Desktops (the app update notice). */
  footer: ReactElement
  hostAttempts: Record<string, number>
  hostLastConnected: Record<string, number | null>
  hostConnections: HomeHostConnections
  hosts: HostCatalogEntry[]
  hostStates: Record<string, ConnectionState>
  isWideLayout: boolean
  worktreeInfo: Record<string, HostWorktreeInfo>
  onOpen: (host: HostCatalogEntry) => void
  onOpenActions: (host: HostCatalogEntry) => void
  onPairDesktop: () => void
}

export function MobileHomeHostList(props: MobileHomeHostListProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingBottom: spacing.xl + props.bottomInset },
        props.isWideLayout && {
          maxWidth: props.contentMaxWidth,
          width: '100%',
          alignSelf: 'center'
        }
      ]}
    >
      {props.header}
      <Text
        style={[homeListStyles.sectionHeading, !props.header && homeListStyles.firstSectionHeading]}
        accessibilityRole="header"
      >
        {t('home.listHeader.desktopsHeading', 'Desktops')}
      </Text>
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
          <Plus size={20} color={colors.accentBlue} />
          <Text style={homeListStyles.actionLabel}>
            {t('home.desktops.pairDesktop', 'Pair a desktop')}
          </Text>
        </Pressable>
      </View>
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

const styles = themedStyleSheet(() => ({
  content: { paddingHorizontal: spacing.lg }
}))
