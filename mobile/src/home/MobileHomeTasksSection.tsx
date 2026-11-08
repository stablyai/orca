import { ChevronRight, ListTodo, type LucideIcon } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { PickerModal } from '../components/PickerModal'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../transport/hosts/host-profile'
import { homeListStyles as styles } from './home-list-styles'

type HomeHostSectionProps = {
  connectedHosts: HostProfile[]
  onOpen: (hostId: string) => void
}

/** Home's Tasks section, opening on a connected desktop. */
export function MobileHomeTasksSection(props: HomeHostSectionProps) {
  const t = useMobileTranslation()
  return (
    <HomeSection
      {...props}
      icon={ListTodo}
      title={t('home.sections.tasks', 'Tasks')}
      subtitle={t('home.sections.tasksSubtitle', 'Browse your issues and reviews')}
      pickerTitle={t('home.listFooter.hostPickerTitle', 'Open Tasks On')}
    />
  )
}

function HomeSection(
  props: HomeHostSectionProps & {
    icon: LucideIcon
    title: string
    subtitle: string
    pickerTitle: string
  }
) {
  useMobileColorScheme()
  const hostPicker = useConnectedHostPicker(props.connectedHosts)
  const enabled = props.connectedHosts.length > 0
  const Icon = props.icon
  return (
    <>
      {/* The row already says Tasks, so it needs no heading of its own. */}
      <View style={[styles.group, styles.headinglessGroup]}>
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
          <View style={styles.tile}>
            <Icon size={17} strokeWidth={1.8} color={colors.textPrimary} />
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
