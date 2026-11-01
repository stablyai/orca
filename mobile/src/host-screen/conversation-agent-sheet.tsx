import { Pressable, Text, View } from 'react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import type { MobileNewTabAgentOption } from '../session/mobile-new-tab-agent-options'
import { conversationCopy } from './conversation-copy'
import { conversationStyles as styles } from './conversation-styles'

export function ConversationAgentSheet({
  visible,
  agents,
  onClose,
  onLaunch
}: {
  visible: boolean
  agents: readonly MobileNewTabAgentOption[]
  onClose: () => void
  onLaunch: (option: MobileNewTabAgentOption) => void
}) {
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.drawer}>
        <Text style={styles.title}>{conversationCopy().agent}</Text>
        {agents.map((option) => (
          <Pressable
            key={option.agent}
            onPress={() => onLaunch(option)}
            style={({ pressed }) => [styles.agentButton, pressed && styles.pressed]}
            accessibilityRole="button"
          >
            <MobileAgentIcon agentId={option.agent} size={20} />
            <Text style={styles.actionText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    </BottomDrawer>
  )
}
