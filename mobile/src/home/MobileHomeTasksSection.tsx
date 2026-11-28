import { memo } from 'react'
import { ChevronRight, ListTodo, type LucideIcon } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { PickerModal } from '../components/sheets/PickerModal'
import { useConnectedHostPicker } from '../host-catalog/selection/use-connected-host-picker'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../host-catalog/host-profile'
import { homeListStylesSheet } from './home-list-styles'
import { useThemedStyles } from '../theme/themed-styles'

type HomeHostSectionProps = {
  connectedHosts: HostProfile[]
  onOpen: (hostId: string) => void
}

// Home rebuilds its connected list on every connection tick; the same computers draw the same section.
const sameSection = (previous: HomeHostSectionProps, next: HomeHostSectionProps): boolean =>
  previous.onOpen === next.onOpen &&
  previous.connectedHosts.length === next.connectedHosts.length &&
  previous.connectedHosts.every((host, at) => host === next.connectedHosts[at])

/** Home's Tasks row, opening on a connected computer. */
export const MobileHomeTasksSection = memo(function MobileHomeTasksSection(
  props: HomeHostSectionProps
) {
  const t = useMobileTranslation()
  return (
    <HomeSection
      {...props}
      icon={ListTodo}
      title={t('home.sections.tasks', 'Tasks')}
      pickerTitle={t('home.listFooter.openTasksOn', 'Open Tasks on')}
    />
  )
}, sameSection)

function HomeSection(
  props: HomeHostSectionProps & {
    icon: LucideIcon
    title: string
    pickerTitle: string
  }
) {
  const styles = useThemedStyles(homeListStylesSheet)
  const colors = useMobileColors()
  const hostPicker = useConnectedHostPicker(props.connectedHosts)
  const Icon = props.icon
  // Nothing to browse until a computer is connected; the row appears then.
  if (props.connectedHosts.length === 0) {
    return null
  }
  return (
    <>
      {/* The row already says Tasks, so it needs no heading of its own. */}
      <View style={[styles.group, styles.headinglessGroup]}>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => hostPicker.pickHost(props.onOpen)}
        >
          <View style={[styles.status, styles.singleLineStatus]}>
            <Icon size={17} strokeWidth={1.8} color={colors.textSecondary} />
          </View>
          <View style={[styles.text, styles.singleLineText]}>
            <Text style={styles.title} numberOfLines={1}>
              {props.title}
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
