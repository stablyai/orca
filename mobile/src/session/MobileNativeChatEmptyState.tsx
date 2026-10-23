import { StyleSheet, Text, View } from 'react-native'
import { AlertCircle, MessageSquare } from 'lucide-react-native'
import type { NativeChatEmptyStateCopy } from '../../../src/shared/native-chat-empty-state'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { StateView } from '../components/ui/StateView'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

/** A chat with nothing in it yet: the agent's mark, who you are talking to and what to ask. A read
 *  that failed takes the shared state view instead. */
export function MobileNativeChatEmptyState({
  copy,
  agent,
  failed
}: {
  copy: NativeChatEmptyStateCopy
  agent: string | null
  failed: boolean
}): React.JSX.Element {
  if (failed) {
    return <StateView icon={AlertCircle} title={copy.title} message={copy.subtitle} />
  }
  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {agent ? (
          <MobileAgentIcon agentId={agent} size={40} />
        ) : (
          <MessageSquare size={36} color={colors.textMuted} strokeWidth={1.75} />
        )}
        <Text style={styles.title} accessibilityRole="header">
          {copy.title}
        </Text>
        <Text style={styles.message}>{copy.subtitle}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl + 16 },
  body: { maxWidth: 300, alignItems: 'center', gap: spacing.sm },
  title: {
    ...textStyles.headline,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: spacing.sm
  },
  message: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' }
})
