import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft, GitBranch, MoreHorizontal, PanelLeftOpen } from 'lucide-react-native'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { MobileSessionTabStrip } from './MobileSessionTabStrip'
import { MobileSessionHeaderMoreActionsSheet } from './MobileSessionHeaderMoreActionsSheet'
import { StatusDot } from '../components/StatusDot'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { verdictDisplayLabel } from '../transport/connection-health'
import { loadHosts } from '../transport/host-store'
import type { ConnectionState, HostProfile } from '../transport/types'
import { useHostDisplay } from '../transport/use-host-display'
import { useHostSidebarReveal } from '../layout/host-sidebar-reveal'
import type { MobileSessionController } from './use-mobile-session-controller'

const STATUS_TEXT: Record<Exclude<ConnectionState, 'connected'>, string> = {
  connecting: 'Connecting…',
  handshaking: 'Securing…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  'auth-failed': 'Pairing invalid'
}

/** The session's navigation bar: back, the workspace over its desktop, two actions; tabs below. */
export function MobileSessionHeader({ controller }: { controller: MobileSessionController }) {
  const {
    hostId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    connState,
    connectionVerdict,
    worktreeName,
    activePanel,
    setShowHeaderMoreActions,
    requestLeaveSession,
    visibleTabs,
    handlePanelTap,
    showHeaderMoreActions,
    showAgentSessionHistoryAction,
    showChecksAction,
    createTabBusy,
    quickCommandsSupported,
    setShowQuickCommands,
    showToast,
    openAgentSessionHistory
  } = controller
  const revealSidebar = useHostSidebarReveal()
  const desktopName = useSessionDesktopName(hostId)
  const escalated = connectionVerdict.kind === 'warning' || connectionVerdict.kind === 'unreachable'
  // The dot is the verdict's colour, so the words beside it say the same thing.
  const subtitle =
    connState === 'connected'
      ? desktopName || 'Connected'
      : escalated || connectionVerdict.kind === 'auth-failed'
        ? verdictDisplayLabel(connectionVerdict)
        : STATUS_TEXT[connState]
  return (
    <SafeAreaView style={styles.chrome} edges={['top']}>
      <View style={styles.bar}>
        <View style={styles.side}>
          {revealSidebar ? (
            <MobileSessionHeaderIconButton
              accessibilityLabel="Show sidebar"
              icon={PanelLeftOpen}
              onPress={revealSidebar}
            />
          ) : null}
          <MobileSessionHeaderIconButton
            accessibilityLabel="Back to worktrees"
            icon={ChevronLeft}
            onPress={requestLeaveSession}
          />
        </View>
        <View style={styles.center}>
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {worktreeName || 'Workspace'}
          </Text>
          <View style={styles.subtitleRow}>
            <StatusDot state={connState} verdict={connectionVerdict} />
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>
        <View style={[styles.side, styles.trailing]}>
          {!isFolderWorkspaceRoute && !isFloatingWorkspaceRoute ? (
            <MobileSessionHeaderIconButton
              active={activePanel === 'sourceControl'}
              accessibilityLabel="Open source control"
              icon={GitBranch}
              onPress={() => handlePanelTap('sourceControl')}
            />
          ) : null}
          <MobileSessionHeaderIconButton
            active={activePanel === 'files' || activePanel === 'pr'}
            accessibilityLabel="More session actions"
            icon={MoreHorizontal}
            onPress={() => setShowHeaderMoreActions(true)}
          />
        </View>
      </View>
      {visibleTabs.length > 0 ? <MobileSessionTabStrip controller={controller} /> : null}
      <MobileSessionHeaderMoreActionsSheet
        visible={showHeaderMoreActions}
        showFiles={!isFloatingWorkspaceRoute}
        filesDocked={activePanel === 'files'}
        showAgentSessionHistory={showAgentSessionHistoryAction}
        showChecks={showChecksAction}
        checksDocked={activePanel === 'pr'}
        quickCommandsDisabled={createTabBusy || connState !== 'connected'}
        quickCommandsSupported={quickCommandsSupported}
        onOpenFiles={() => handlePanelTap('files')}
        onOpenAgentSessionHistory={openAgentSessionHistory}
        onOpenChecks={() => handlePanelTap('pr')}
        onShowQuickCommands={() => setShowQuickCommands(true)}
        onToast={showToast}
        onClose={() => setShowHeaderMoreActions(false)}
      />
    </SafeAreaView>
  )
}

/** The paired desktop's display name, for the line under the workspace. */
function useSessionDesktopName(hostId: string | undefined): string {
  const [host, setHost] = useState<HostProfile | null>(null)
  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    loadHosts().then(
      (hosts) => {
        if (!stale) {
          setHost(hosts.find((profile) => profile.id === hostId) ?? null)
        }
      },
      // An unreadable profile leaves the name out; the dot still says how the link is.
      () => {}
    )
    return () => {
      stale = true
    }
  }, [hostId])
  const title = useHostDisplay(host).title
  return host ? title : ''
}

const styles = StyleSheet.create({
  chrome: { backgroundColor: colors.bgBase },
  bar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs
  },
  side: { minWidth: 92, flexDirection: 'row', alignItems: 'center' },
  trailing: { justifyContent: 'flex-end' },
  center: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: { ...textStyles.headline, color: colors.textPrimary },
  subtitleRow: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  subtitle: { ...textStyles.caption, color: colors.textSecondary, flexShrink: 1 }
})
