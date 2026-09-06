import { Pressable, Text, View } from 'react-native'
import { ChevronsDownUp, ChevronsUpDown, Square } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import { MobileAgentWorkingIndicator } from './MobileAgentWorkingIndicator'

type Props = {
  agentWorking?: boolean
  /** The structured lane renders per-turn status rows, so it suppresses the
   *  bridge lane's three-dot working indicator. */
  structuredActivityUi: boolean
  toolsExpanded: boolean
  onToggleTools: () => void
  onStop?: () => void
}

/** Tools-disclosure toggle plus the mid-turn Stop button, below the transcript. */
export function MobileNativeChatChromeRow({
  agentWorking,
  structuredActivityUi,
  toolsExpanded,
  onToggleTools,
  onStop
}: Props): React.JSX.Element {
  return (
    <View style={styles.chromeRow}>
      <View style={styles.chromeLeft}>
        {agentWorking && !structuredActivityUi ? <MobileAgentWorkingIndicator /> : null}
        <Pressable
          style={({ pressed }) => [styles.chromeToggle, pressed && styles.pressed]}
          onPress={onToggleTools}
          hitSlop={8}
        >
          {toolsExpanded ? (
            <ChevronsDownUp size={14} color={colors.textMuted} strokeWidth={2} />
          ) : (
            <ChevronsUpDown size={14} color={colors.textMuted} strokeWidth={2} />
          )}
          <Text style={styles.chromeToggleLabel}>{toolsExpanded ? 'Collapse' : 'Tools'}</Text>
        </Pressable>
      </View>
      {agentWorking ? (
        <Pressable
          style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
          onPress={onStop}
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
