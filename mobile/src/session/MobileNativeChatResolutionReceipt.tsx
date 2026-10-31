import { agentSessionFormBooleanLabels } from '../../../src/shared/agent-session-form-copy'
import { ActivityIndicator } from 'react-native'
import { useMobileNativeChatSettledBody } from './mobile-native-chat-settled-body'
import { StyleSheet, Text, View } from 'react-native'
import {
  nativeChatReceiptAnswerHeading,
  nativeChatReceiptAnswers,
  nativeChatReceiptSubject,
  type NativeChatResolvedPrompt
} from '../../../src/shared/native-chat-resolution-receipt'
import { nativeChatReceiptCopy } from './native-chat-receipt-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileNativeChatAwaitingInputRow } from './native-chat/transcript/MobileNativeChatAwaitingInputRow'
import { scaledType } from './native-chat/transcript/mobile-native-chat-message-styles'
import { MobileNativeChatMessageTime } from './native-chat/transcript/MobileNativeChatMessageTime'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MobileNativeChatResolutionReceipt({
  body: presentation,
  awaiting = true,
  fontScale
}: {
  body: NativeChatResolvedPrompt
  /** False once the agent that asked has ended. */
  awaiting?: boolean
  fontScale: number
}): React.JSX.Element | null {
  const hydrated = useMobileNativeChatSettledBody(presentation)
  const body =
    presentation.deferredBody && hydrated.status === 'ready' ? hydrated.body : presentation
  const incomplete = !!body.deferredBody
  useMobileColorScheme()
  const t = useMobileTranslation()
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
  const copy = nativeChatReceiptCopy(t, resolution.resolvedBy ?? undefined)
  const cancelled = resolution.state === 'cancelled'
  const answers = incomplete ? [] : nativeChatReceiptAnswers(body, agentSessionFormBooleanLabels(t))
  const outcome = [
    cancelled ? copy.cancelled : copy.resolved,
    resolution.resolvedBy ? (cancelled ? copy.cancelledBy : copy.resolver) : null
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
      {incomplete ? (
        hydrated.status === 'loading' ? (
          <ActivityIndicator size="small" />
        ) : (
          <Text style={text}>{copy.unavailable}</Text>
        )
      ) : null}
      {answers.map((answer, index) => {
        const heading = nativeChatReceiptAnswerHeading(subject, answer)
        return (
          <View
            key={
              body.kind === 'question'
                ? (body.questions?.[index]?.id ?? 'answer')
                : `${index}:${answer.question ?? ''}`
            }
          >
            {heading ? <Text style={text}>{heading}</Text> : null}
            <Text
              selectable={INLINE_TEXT_SELECTION}
              style={text}
              numberOfLines={body.kind === 'approval' && body.form ? undefined : 3}
            >
              {answer.answer === '' ? copy.emptyAnswer : (answer.answer ?? copy.unavailable)}
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
