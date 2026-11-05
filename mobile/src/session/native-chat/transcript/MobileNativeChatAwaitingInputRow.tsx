import { Text, View } from 'react-native'
import { MessageSquareMore } from 'lucide-react-native'
import type { NativeChatAskRowSubject } from '../../../../../src/shared/native-chat/input/native-chat-ask-row'
import { nativeChatAskRowCopy } from './native-chat-ask-row-copy'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { scaledType } from './mobile-native-chat-message-styles'
import { MobileNativeChatQuestionText } from '../MobileNativeChatQuestionText'

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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const copy = nativeChatAskRowCopy(
    t,
    subject?.kind === 'questions' ? subject.questions.length : undefined
  )
  const label = !pending ? copy.asked : subject === null ? copy.awaitingUnnamed : copy.awaiting
  // The count stays in the label; questions are agent text, so they draw below it as chat markdown.
  const count = subject?.kind === 'questions' ? copy.questionCount : null
  const type = scaledType(typography.bodySize, fontScale)
  const question = subject?.kind === 'question' ? subject.text : null
  const questions =
    subject?.kind === 'questions' && listsQuestions ? keyedQuestions(subject.questions) : null
  const indent = { paddingLeft: ICON_SIZE * fontScale + spacing.sm }
  return (
    <>
      {/* The question shares the label's live region, so a pending ask is announced whole. */}
      <View accessibilityLiveRegion={pending ? 'polite' : undefined}>
        <View style={styles.row}>
          <MessageSquareMore
            size={ICON_SIZE * fontScale}
            color={colors.textMuted}
            strokeWidth={2}
            style={{ marginTop: 3 * fontScale }}
          />
          <Text selectable={INLINE_TEXT_SELECTION} style={[styles.label, type]}>
            {label}
            {count === null ? null : <Text style={[styles.question, type]}> {count}</Text>}
          </Text>
        </View>
        {question === null ? null : (
          <MobileNativeChatQuestionText
            content={question}
            fontSize={type.fontSize}
            rangeSelectable
            style={indent}
          />
        )}
      </View>
      {questions === null ? null : (
        <View style={indent}>
          {/* Numbers stay outside the agent's text so its own markdown cannot restyle them. */}
          {questions.map(({ key, entry }, index) => (
            <View key={key} style={styles.entry}>
              <Text style={[styles.question, type]}>{`${index + 1}.`}</Text>
              <MobileNativeChatQuestionText
                content={entry}
                fontSize={type.fontSize}
                rangeSelectable
                style={styles.entryText}
              />
            </View>
          ))}
        </View>
      )}
    </>
  )
}

// Agents may repeat a question, so its text alone is not a unique key.
function keyedQuestions(questions: readonly string[]): { key: string; entry: string }[] {
  const seen = new Map<string, number>()
  return questions.map((entry) => {
    const occurrence = seen.get(entry) ?? 0
    seen.set(entry, occurrence + 1)
    return { key: `${occurrence}:${entry}`, entry }
  })
}

const styles = themedStyleSheet(() => ({
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
  },
  entry: {
    flexDirection: 'row',
    gap: spacing.xs
  },
  entryText: {
    flex: 1
  }
}))
