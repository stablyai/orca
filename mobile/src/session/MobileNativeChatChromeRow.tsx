import { Pressable, Text, View } from 'react-native'
import { ChevronsDownUp, ChevronsUpDown, Square } from 'lucide-react-native'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'
import { styles } from './mobile-native-chat-view-styles'
import { colors } from '../theme/mobile-theme'

/**
 * The strip above the composer: working indicator and the global tool-calls
 * toggle on the left, Stop in the far corner.
 */
export function MobileNativeChatChromeRow(props: {
  agentWorking?: boolean
  structuredActivityUi?: boolean
  toolsExpanded: boolean
  onToggleTools: () => void
  onStop?: () => void
}): React.JSX.Element {
  return (
    <View style={styles.chromeRow}>
      <View style={styles.chromeLeft}>
        {props.agentWorking && !props.structuredActivityUi ? <MobileAgentWorkingIndicator /> : null}
        <Pressable
          style={({ pressed }) => [styles.chromeToggle, pressed && styles.pressed]}
          onPress={props.onToggleTools}
          hitSlop={8}
        >
          {props.toolsExpanded ? (
            <ChevronsDownUp size={14} color={colors.textMuted} strokeWidth={2} />
          ) : (
            <ChevronsUpDown size={14} color={colors.textMuted} strokeWidth={2} />
          )}
          <Text style={styles.chromeToggleLabel}>{props.toolsExpanded ? 'Collapse' : 'Tools'}</Text>
        </Pressable>
      </View>
      {props.agentWorking && props.onStop ? (
        <Pressable
          style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
          onPress={props.onStop}
          hitSlop={8}
          accessibilityLabel="Stop the agent"
        >
          <Square size={13} color={colors.statusRed} strokeWidth={2.4} fill={colors.statusRed} />
          <Text style={styles.stopLabel}>Stop</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
