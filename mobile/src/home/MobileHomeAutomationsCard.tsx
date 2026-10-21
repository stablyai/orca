import { CalendarClock, ChevronRight } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { automationStyles as styles } from '../automations/automation-styles'

export function MobileHomeAutomationsCard({
  enabled,
  onOpen
}: {
  enabled: boolean
  onOpen: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Automations"
      disabled={!enabled}
      onPress={onOpen}
      style={[styles.card, !enabled && styles.disabled]}
    >
      <View style={styles.row}>
        <CalendarClock size={22} color={colors.textSecondary} />
        <View style={styles.grow}>
          <Text style={styles.heading}>Automations</Text>
          <Text style={styles.meta}>Schedule agent work and view runs</Text>
        </View>
        <ChevronRight size={16} color={colors.textMuted} />
      </View>
    </Pressable>
  )
}
