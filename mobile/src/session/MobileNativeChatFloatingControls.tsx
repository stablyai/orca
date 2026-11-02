import { Pressable, Text, View } from 'react-native'
import { ArrowDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'

/** Floats over the transcript's bottom-right so the Tools toggle and jump-to-latest take no row. */
export function MobileNativeChatFloatingControls({
  toolCallCount,
  toolsExpanded,
  onToggleTools,
  showJumpToTail,
  onJumpToTail
}: {
  toolCallCount: number
  toolsExpanded: boolean
  onToggleTools: () => void
  showJumpToTail: boolean
  onJumpToTail: () => void
}): React.JSX.Element {
  return (
    <View pointerEvents="box-none" style={styles.floatingControls}>
      {toolCallCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toolsExpanded ? 'Collapse tool runs' : 'Expand tool runs'}
          style={({ pressed }) => [styles.toolsPill, pressed && styles.pressed]}
          onPress={onToggleTools}
        >
          {toolsExpanded ? (
            <ChevronsDownUp size={14} color={colors.textSecondary} strokeWidth={2} />
          ) : (
            <ChevronsUpDown size={14} color={colors.textSecondary} strokeWidth={2} />
          )}
          <Text style={styles.toolsPillLabel}>
            {toolsExpanded ? 'Collapse' : `Tools · ${toolCallCount}`}
          </Text>
        </Pressable>
      ) : null}
      {showJumpToTail ? (
        <Pressable accessibilityLabel="Scroll to latest" style={styles.fab} onPress={onJumpToTail}>
          <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
  )
}
