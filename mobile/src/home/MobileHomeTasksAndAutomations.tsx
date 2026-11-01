import { CalendarClock, ChevronRight, ListTodo, type LucideIcon } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { PickerModal } from '../components/PickerModal'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../transport/types'
import { homeListStyles as styles } from './home-list-styles'

/** Home's Tasks and Automations sections, each opening on a connected desktop. */
export function MobileHomeTasksAndAutomations(props: {
  connectedHosts: HostProfile[]
  onOpenTasks: (hostId: string) => void
  onOpenAutomations: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const tasksHostPicker = useConnectedHostPicker(props.connectedHosts)
  const automationsHostPicker = useConnectedHostPicker(props.connectedHosts)
  const enabled = props.connectedHosts.length > 0
  return (
    <>
      <HomeSection
        icon={ListTodo}
        title={t('home.bottomBar.tasks', 'Tasks')}
        subtitle={t('home.sections.tasksSubtitle', 'Issues and pull requests')}
        enabled={enabled}
        onPress={() => tasksHostPicker.pickHost(props.onOpenTasks)}
      />
      <HomeSection
        icon={CalendarClock}
        title={t('home.listFooter.automationsHeading', 'Automations')}
        subtitle={t(
          'automations.mobile.scheduleAgentWorkAndViewRuns',
          'Schedule agent work and view runs'
        )}
        enabled={enabled}
        onPress={() => automationsHostPicker.pickHost(props.onOpenAutomations)}
      />
      <PickerModal
        title={t('home.listFooter.hostPickerTitle', 'Open Tasks On')}
        {...tasksHostPicker.pickerProps}
      />
      <PickerModal
        title={t('home.listFooter.automationsHostPickerTitle', 'Open Automations On')}
        {...automationsHostPicker.pickerProps}
      />
    </>
  )
}

function HomeSection(props: {
  icon: LucideIcon
  title: string
  subtitle: string
  enabled: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const Icon = props.icon
  return (
    <>
      <Text style={styles.sectionHeading} accessibilityRole="header">
        {props.title}
      </Text>
      <View style={styles.group}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.title}, ${props.subtitle}`}
          accessibilityState={{ disabled: !props.enabled }}
          disabled={!props.enabled}
          style={({ pressed }) => [
            styles.row,
            pressed && styles.rowPressed,
            !props.enabled && styles.rowDisabled
          ]}
          onPress={props.onPress}
        >
          <View style={styles.status}>
            <Icon size={18} color={colors.textSecondary} />
          </View>
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={1}>
              {props.title}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {props.subtitle}
            </Text>
          </View>
          <View style={styles.trailing}>
            <ChevronRight size={16} color={colors.textMuted} />
          </View>
        </Pressable>
      </View>
    </>
  )
}
