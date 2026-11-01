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
  return (
    <>
      <HomeSection
        icon={ListTodo}
        title={t('home.sections.tasks', 'Tasks')}
        subtitle={t('home.sections.tasksSubtitle', 'Browse your issues and reviews')}
        pickerTitle={t('home.listFooter.hostPickerTitle', 'Open Tasks On')}
        connectedHosts={props.connectedHosts}
        onOpen={props.onOpenTasks}
      />
      <HomeSection
        icon={CalendarClock}
        title={t('home.listFooter.automationsHeading', 'Automations')}
        subtitle={t(
          'automations.mobile.scheduleAgentWorkAndViewRuns',
          'Schedule agent work and view runs'
        )}
        pickerTitle={t('home.listFooter.automationsHostPickerTitle', 'Open Automations On')}
        connectedHosts={props.connectedHosts}
        onOpen={props.onOpenAutomations}
      />
    </>
  )
}

function HomeSection(props: {
  icon: LucideIcon
  title: string
  subtitle: string
  pickerTitle: string
  connectedHosts: HostProfile[]
  onOpen: (hostId: string) => void
}) {
  useMobileColorScheme()
  const hostPicker = useConnectedHostPicker(props.connectedHosts)
  const enabled = props.connectedHosts.length > 0
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
          accessibilityState={{ disabled: !enabled }}
          disabled={!enabled}
          style={({ pressed }) => [
            styles.row,
            pressed && styles.rowPressed,
            !enabled && styles.rowDisabled
          ]}
          onPress={() => hostPicker.pickHost(props.onOpen)}
        >
          <View style={styles.status}>
            <Icon size={18} color={colors.textSecondary} />
          </View>
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={1}>
              {props.title}
            </Text>
            <Text style={styles.subtitle} numberOfLines={2}>
              {props.subtitle}
            </Text>
          </View>
          <View style={styles.trailing}>
            <ChevronRight size={16} color={colors.textMuted} />
          </View>
        </Pressable>
      </View>
      <PickerModal title={props.pickerTitle} {...hostPicker.pickerProps} />
    </>
  )
}
