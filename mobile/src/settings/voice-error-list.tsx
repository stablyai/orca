import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

/** Voice-screen errors, newest first, one line block each so two failures never run together. */
export function VoiceErrorList({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) {
    return null
  }
  return (
    <View style={styles.list}>
      {messages.map((message) => (
        <Text key={message} style={styles.message}>
          {message}
        </Text>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { marginTop: spacing.md, gap: spacing.xs },
  message: { color: colors.statusRed, fontSize: typography.metaSize }
})
