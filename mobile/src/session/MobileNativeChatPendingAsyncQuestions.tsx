import { colors, spacing, typography } from '../theme/mobile-theme'
import { useContext } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { MobileNativeChatAsyncQuestionContext } from './mobile-native-chat-async-question-context'
import { MobileNativeChatAsyncQuestions } from './MobileNativeChatAsyncQuestions'

/** Uses the host's pending set, independently of the mobile history window. */
export function MobileNativeChatPendingAsyncQuestions(): React.JSX.Element | null {
  const reply = useContext(MobileNativeChatAsyncQuestionContext)
  if (!reply?.pendingQuestions?.length) {
    return null
  }
  return (
    <ScrollView style={styles.cards} keyboardShouldPersistTaps="handled">
      {reply.pendingQuestions.map((group) => (
        <View key={`${group.key}:${JSON.stringify(group.questions)}`}>
          <MobileNativeChatAsyncQuestions questions={group.questions} />
          {group.omittedCount ? (
            <Text style={styles.notice}>
              More pending questions are available in the transcript.
            </Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}
const styles = StyleSheet.create({
  cards: { maxHeight: 240, flexGrow: 0 },
  notice: { color: colors.textPrimary, fontSize: typography.bodySize, padding: spacing.md }
})
