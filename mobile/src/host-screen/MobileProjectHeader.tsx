import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, Ellipsis } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { StatusDot } from '../components/StatusDot'
import { projectListStyles as styles } from './mobile-project-list-styles'
import type { HostScreenController } from './use-host-screen-controller'

export function MobileProjectHeader({ controller }: { controller: HostScreenController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [menu, setMenu] = useState(false)
  const { actions, connState, connectionVerdict, hostDisplay, hostId, state } = controller
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
            style={styles.menuRow}
            accessibilityRole="button"
            onPress={() => {
              setMenu(false)
              actions.navigateFromHostList(`/h/${encodeURIComponent(hostId ?? '')}/accounts`)
            }}
          >
            <Text style={styles.title}>
              {t('hostScreen.projectNavigation.accounts', 'Accounts and usage')}
            </Text>
          </Pressable>
          {controller.floatingWorkspaceEnabled && (
            <Pressable
              style={styles.menuRow}
              accessibilityRole="button"
              disabled={connState !== 'connected'}
              onPress={actions.openFloatingWorkspace}
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
