import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, Ellipsis } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { StatusDot } from '../components/StatusDot'
import { isConnectionOutage } from '../transport/connection-health'
import { projectListStyles as styles } from './mobile-project-list-styles'
import type { HostScreenController } from './use-host-screen-controller'

export function MobileProjectHeader({ controller }: { controller: HostScreenController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [menu, setMenu] = useState(false)
  const { actions, connState, connectionVerdict, forceReconnectHost, hostDisplay, hostId, state } =
    controller
  const disconnected = connState !== 'connected'
  const hostPath = `/h/${encodeURIComponent(hostId ?? '')}`
  return (
    <>
      <View style={styles.top}>
        <Pressable
          style={styles.icon}
          accessibilityRole="button"
          accessibilityLabel={t('hostScreen.projectNavigation.hosts', 'Hosts')}
          onPress={actions.leaveHost}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.host}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StatusDot state={connState} verdict={connectionVerdict} />
            <Text style={[styles.title, { flexShrink: 1 }]} numberOfLines={1}>
              {hostDisplay.title}
            </Text>
          </View>
        </View>
        {isConnectionOutage(connectionVerdict) && hostId && forceReconnectHost !== null ? (
          <Pressable
            style={styles.reconnect}
            accessibilityRole="button"
            accessibilityLabel={t('hostScreen.hostScreenHeader.reconnect', 'Reconnect')}
            hitSlop={8}
            onPress={() => void forceReconnectHost(hostId)}
          >
            <Text style={styles.reconnectText}>
              {t('hostScreen.hostScreenHeader.reconnect', 'Reconnect')}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.icon}
          accessibilityRole="button"
          accessibilityLabel={t('hostScreen.projectNavigation.more', 'More')}
          accessibilityState={{ expanded: menu }}
          onPress={() => setMenu(!menu)}
        >
          <Ellipsis size={20} color={colors.textPrimary} />
        </Pressable>
      </View>
      {menu && (
        <View style={styles.menu}>
          <Pressable
            style={styles.menuRow}
            accessibilityRole="button"
            onPress={() => {
              setMenu(false)
              state.setShowWorkspaceOptions(true)
            }}
          >
            <Text style={styles.title}>
              {t('hostScreen.projectNavigation.settings', 'Workspace settings')}
            </Text>
            <Text style={styles.meta}>
              {t('hostScreen.projectNavigation.sharedFilters', 'Filters shared with desktop')}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.menuRow, disconnected && styles.menuDisabled]}
            accessibilityRole="button"
            accessibilityLabel={t('hostScreen.hostScreenHeader.tasks', 'Tasks')}
            disabled={disconnected}
            onPress={() => {
              setMenu(false)
              actions.navigateFromHostList(`${hostPath}/tasks`)
            }}
          >
            <Text style={styles.title}>{t('hostScreen.hostScreenHeader.tasks', 'Tasks')}</Text>
          </Pressable>
          <Pressable
            style={[styles.menuRow, disconnected && styles.menuDisabled]}
            accessibilityRole="button"
            accessibilityLabel={t('hostScreen.hostScreenHeader.automations', 'Automations')}
            disabled={disconnected}
            onPress={() => {
              setMenu(false)
              actions.navigateFromHostList(`${hostPath}/automations`)
            }}
          >
            <Text style={styles.title}>
              {t('hostScreen.hostScreenHeader.automations', 'Automations')}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.menuRow, disconnected && styles.menuDisabled]}
            accessibilityRole="button"
            disabled={disconnected}
            onPress={() => {
              setMenu(false)
              actions.navigateFromHostList(`${hostPath}/accounts`)
            }}
          >
            <Text style={styles.title}>
              {t('hostScreen.projectNavigation.accounts', 'Accounts and usage')}
            </Text>
          </Pressable>
          {controller.floatingWorkspaceEnabled && (
            <Pressable
              style={[styles.menuRow, disconnected && styles.menuDisabled]}
              accessibilityRole="button"
              disabled={disconnected}
              onPress={() => {
                setMenu(false)
                actions.openFloatingWorkspace()
              }}
            >
              <Text style={styles.title}>
                {t('hostScreen.projectNavigation.floating', 'Floating workspace')}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </>
  )
}
