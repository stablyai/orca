import { StyleSheet, Text, View } from 'react-native'
import { MessageSquareMore } from 'lucide-react-native'
import {
  NATIVE_CHAT_ASK_ROW_COPY,
  type NativeChatAskRowSubject
} from '../../../src/shared/native-chat/input/native-chat-ask-row'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { scaledType } from './mobile-native-chat-message-styles'

const ICON_SIZE = 15

export function MobileNativeChatAwaitingInputRow({
  subject,
  pending,
  fontScale,
  listsQuestions = true
}: {
  subject: NativeChatAskRowSubject | null
  pending: boolean
  fontScale: number
  // Suppress duplicate question lists when the grouped prompt already renders them.
  listsQuestions?: boolean
}): React.JSX.Element {
  const label = !pending
    ? NATIVE_CHAT_ASK_ROW_COPY.asked
    : subject === null
      ? NATIVE_CHAT_ASK_ROW_COPY.awaitingUnnamed
      : NATIVE_CHAT_ASK_ROW_COPY.awaiting
  const text =
    subject === null
      ? null
      : subject.kind === 'question'
        ? subject.text
        : NATIVE_CHAT_ASK_ROW_COPY.questionCount.replace(
            '{{value0}}',
            String(subject.questions.length)
          )
  const type = scaledType(typography.bodySize, fontScale)
  const questions = subject?.kind === 'questions' && listsQuestions ? subject.questions : null
  return (
    <>
      <View style={styles.row} accessibilityLiveRegion={pending ? 'polite' : undefined}>
        <MessageSquareMore
          size={ICON_SIZE * fontScale}
          color={colors.textMuted}
          strokeWidth={2}
          style={{ marginTop: 3 * fontScale }}
        />
        <Text selectable={INLINE_TEXT_SELECTION} style={[styles.label, type]}>
          {label}
          {text === null ? null : <Text style={[styles.question, type]}> {text}</Text>}
        </Text>
      </View>
      {questions === null ? null : (
        <View style={{ paddingLeft: ICON_SIZE * fontScale + spacing.sm }}>
          {questions.map((question, index) => (
            <Text
              key={index}
              selectable={INLINE_TEXT_SELECTION}
              style={[styles.question, type]}
            >{`${index + 1}. ${question}`}</Text>
          ))}
        </View>
      )}
    </>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 3
  },
  label: {
    flex: 1,
    color: colors.textMuted
  },
  question: {
    color: colors.textPrimary
  }
})
