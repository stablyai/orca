import { StyleSheet, Text, View } from 'react-native'
import {
  NATIVE_CHAT_RECEIPT_COPY,
  nativeChatReceiptAnswerHeading,
  nativeChatReceiptAnswers,
  nativeChatReceiptSubject,
  type NativeChatResolvedPrompt
} from '../../../src/shared/native-chat-resolution-receipt'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileNativeChatAwaitingInputRow } from './native-chat/transcript/MobileNativeChatAwaitingInputRow'
import { scaledType } from './native-chat/transcript/mobile-native-chat-message-styles'
import { MobileNativeChatMessageTime } from './native-chat/transcript/MobileNativeChatMessageTime'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MobileNativeChatResolutionReceipt({
  body,
  awaiting = true,
  fontScale
}: {
  body: NativeChatResolvedPrompt
  /** False once the agent that asked has ended. */
  awaiting?: boolean
  fontScale: number
}): React.JSX.Element | null {
  useMobileColorScheme()
  const subject = nativeChatReceiptSubject(body)
  if (body.resolution.state === 'pending') {
    return body.kind === 'question' ? (
      <MobileNativeChatAwaitingInputRow
        subject={subject}
        pending={awaiting}
        fontScale={fontScale}
        // While the host waits, its answer card lists them.
        listsQuestions={!awaiting}
      />
    ) : null
  }
  const { resolution } = body
  const cancelled = resolution.state === 'cancelled'
  const answers = nativeChatReceiptAnswers(body)
  const outcome = [
    cancelled ? NATIVE_CHAT_RECEIPT_COPY.cancelled : NATIVE_CHAT_RECEIPT_COPY.resolved,
    resolution.resolvedBy
      ? (cancelled
          ? NATIVE_CHAT_RECEIPT_COPY.cancelledBy
          : NATIVE_CHAT_RECEIPT_COPY.resolver
        ).replace('{{device}}', resolution.resolvedBy)
      : null
  ]
  const text = [styles.text, scaledType(typography.metaSize, fontScale, 5)]
  return (
    <View style={styles.receipt}>
      {body.kind === 'question' ? (
        <MobileNativeChatAwaitingInputRow
          subject={subject}
          pending={false}
          fontScale={fontScale}
          listsQuestions={answers.length === 0}
        />
      ) : (
        <Text selectable={INLINE_TEXT_SELECTION} style={[text, styles.title]}>
          {body.displayName ?? body.title}
        </Text>
      )}
      {body.kind === 'approval' && body.detail ? (
        <Text selectable={INLINE_TEXT_SELECTION} style={text} numberOfLines={3}>
          {body.detail}
        </Text>
      ) : null}
      {answers.map((answer, index) => {
        const heading = nativeChatReceiptAnswerHeading(subject, answer)
        return (
          <View
            key={body.kind === 'question' ? (body.questions?.[index]?.id ?? 'answer') : 'answer'}
          >
            {heading ? <Text style={text}>{heading}</Text> : null}
            <Text selectable={INLINE_TEXT_SELECTION} style={text} numberOfLines={3}>
              {answer.answer === ''
                ? NATIVE_CHAT_RECEIPT_COPY.emptyAnswer
                : (answer.answer ?? NATIVE_CHAT_RECEIPT_COPY.unavailable)}
            </Text>
          </View>
        )
      })}
      <View style={styles.outcome}>
        <Text style={text}>{outcome.filter(Boolean).join(' · ')}</Text>
        <MobileNativeChatMessageTime timestamp={resolution.resolvedAt} fontScale={fontScale} />
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  receipt: {
    gap: spacing.xs,
    paddingLeft: spacing.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle
  },
  text: {
    color: colors.textMuted
  },
  title: {
    fontWeight: '600'
  },
  outcome: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm
  }
}))
