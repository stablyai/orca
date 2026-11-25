import { Text, View } from 'react-native'
import { MessageSquareMore } from '../../../../components/icons/app-icons'
import type { NativeChatAskRowSubject } from '../../../../../../src/shared/native-chat/input/questions/native-chat-ask-row'
import { nativeChatAskRowCopy } from './native-chat-ask-row-copy'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { scaledType } from './mobile-native-chat-message-styles'
import { MobileNativeChatQuestionText } from '../message-content/MobileNativeChatQuestionText'
import { MobileNativeChatEventName, MobileNativeChatEventRow } from './MobileNativeChatEventRow'

/** The chat's ask mark, shared by its asked and answered lines. */
export function MobileNativeChatAskMark(): React.JSX.Element {
  return <MessageSquareMore size={14} color={colors.textMuted} strokeWidth={2} />
}

/** An ask as one status line, as the desktop's: "Asked:" or "Awaiting user input:" and the question,
 *  which opens in full below it. */
export function MobileNativeChatAwaitingInputRow({
  subject,
  pending,
  fontScale,
  listsQuestions = true,
  headline: showsHeadline = true,
  disclosureKey
}: {
  /** Null when the payload named none, or the open answer card already shows it. */
  subject: NativeChatAskRowSubject | null
  pending: boolean
  fontScale: number
  // Suppress duplicate question lists when the grouped prompt already renders them.
  listsQuestions?: boolean
  /** False when the open answer card shows the question; the line still opens to it. */
  headline?: boolean
  disclosureKey?: string
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const copy = nativeChatAskRowCopy(
    t,
    subject?.kind === 'questions' ? subject.questions.length : undefined
  )
  const label = !pending
    ? copy.asked
    : subject === null || !showsHeadline
      ? copy.awaitingUnnamed
      : copy.awaiting
  const headline =
    subject === null || !showsHeadline
      ? null
      : subject.kind === 'question'
        ? subject.text
        : copy.questionCount
  const questions =
    subject === null
      ? null
      : subject.kind === 'question'
        ? [subject.text]
        : listsQuestions
          ? subject.questions
          : null
  return (
    <View accessibilityLiveRegion={pending ? 'polite' : undefined}>
      <MobileNativeChatEventRow
        icon={<MobileNativeChatAskMark />}
        label={[label, headline].filter(Boolean).join(' ')}
        disclosureKey={disclosureKey}
        fontScale={fontScale}
        details={questions ? <AskQuestions questions={questions} fontScale={fontScale} /> : null}
      >
        {label}
        {headline === null ? null : (
          <>
            {' '}
            <MobileNativeChatEventName>{headline}</MobileNativeChatEventName>
          </>
        )}
      </MobileNativeChatEventRow>
    </View>
  )
}

/** Questions in full, numbered when there are several; agent text, so drawn as chat markdown. */
export function AskQuestions({
  questions,
  fontScale
}: {
  questions: readonly string[]
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const type = scaledType(typography.metaSize, fontScale)
  return (
    <>
      {keyedQuestions(questions).map(({ key, entry }, index) => (
        <View key={key} style={styles.entry}>
          {/* Numbers stay outside the agent's text so its own markdown cannot restyle them. */}
          {questions.length > 1 ? (
            <Text style={[styles.number, type]}>{`${index + 1}.`}</Text>
          ) : null}
          <MobileNativeChatQuestionText
            content={entry}
            fontSize={type.fontSize}
            rangeSelectable
            style={styles.entryText}
          />
        </View>
      ))}
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
  entry: { flexDirection: 'row', gap: spacing.xs },
  number: { color: colors.textMuted },
  entryText: { flex: 1 }
}))
