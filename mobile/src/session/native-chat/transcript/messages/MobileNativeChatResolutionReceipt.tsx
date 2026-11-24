import { StyleSheet, Text, View } from 'react-native'
import {
  ShieldCheck,
  ShieldMinus,
  ShieldQuestion,
  ShieldX
} from '../../../../components/icons/app-icons'
import {
  nativeChatReceiptAnswerHeading,
  nativeChatReceiptAnswers,
  nativeChatReceiptDevice,
  nativeChatReceiptSubject,
  type NativeChatReceiptAnswer,
  type NativeChatResolvedPrompt
} from '../../../../../../src/shared/native-chat/input/questions/native-chat-resolution-receipt'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  ownApprovalRecord,
  type OwnApprovalRecordSentence
} from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-record'
import { readShellApprovalDetail } from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-shell-detail'
import type { WorkerApprovalRecordTone } from '../../../../../../src/shared/orchestration/approvals/worker-approval-record'
import {
  isPlanApprovalSubject,
  urlApprovalProgress
} from '../../../../../../src/shared/agent-session/requests/prompts/agent-session-approval-subject'
import { nativeChatReceiptCopy } from './native-chat-receipt-copy'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { INLINE_TEXT_SELECTION } from '../../../../platform/text-selection/inline-text-selection'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import {
  AskQuestions,
  MobileNativeChatAskMark,
  MobileNativeChatAwaitingInputRow
} from './MobileNativeChatAwaitingInputRow'
import { MobileNativeChatQuestionText } from '../message-content/MobileNativeChatQuestionText'
import { MONO_SIZE, scaledType } from './mobile-native-chat-message-styles'
import { MobileNativeChatMessageTime } from './MobileNativeChatMessageTime'
import { MobileNativeChatEventName, MobileNativeChatEventRow } from './MobileNativeChatEventRow'
import { RECORD_SENTENCE_KEEP, recordSentenceParts } from './native-chat-record-sentence'
import { MobileNativeChatUrlRequestReceipt } from '../../input/prompts/MobileNativeChatUrlRequest'

/** A prompt once answered, as one quiet line whose details open below it; a plan review keeps its
 *  full receipt, as on the desktop, since the plan is what was answered. */
export function MobileNativeChatResolutionReceipt({
  body,
  awaiting = true,
  disclosureKey,
  fontScale
}: {
  body: NativeChatResolvedPrompt
  /** False once the agent that asked has ended. */
  awaiting?: boolean
  /** Where the transcript remembers whether this line's details are open. */
  disclosureKey?: string
  fontScale: number
}): React.JSX.Element | null {
  const subject = nativeChatReceiptSubject(body)
  if (body.resolution.state === 'pending') {
    return body.kind === 'question' ? (
      <MobileNativeChatAwaitingInputRow
        subject={subject}
        // While the host waits, its answer card shows the question; the line still opens to it.
        headline={!awaiting}
        pending={awaiting}
        fontScale={fontScale}
        disclosureKey={disclosureKey}
      />
    ) : null
  }
  if (body.kind === 'question') {
    return <QuestionRecord body={body} disclosureKey={disclosureKey} fontScale={fontScale} />
  }
  const urlProgress = urlApprovalProgress(body)
  if (urlProgress) {
    return <MobileNativeChatUrlRequestReceipt body={body} {...urlProgress} fontScale={fontScale} />
  }
  return isPlanApprovalSubject(body.subject) ? (
    <PlanReceipt body={body} fontScale={fontScale} />
  ) : (
    <ApprovalRecord body={body} disclosureKey={disclosureKey} fontScale={fontScale} />
  )
}

const TONE_ICON: Record<WorkerApprovalRecordTone, typeof ShieldCheck> = {
  allowed: ShieldCheck,
  denied: ShieldX,
  open: ShieldQuestion,
  closed: ShieldMinus
}

/** "You allowed Bash · cd mobile…", the command in full below it. */
function ApprovalRecord({
  body,
  disclosureKey,
  fontScale
}: {
  body: AgentJournalApprovalItem
  disclosureKey?: string
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const record = ownApprovalRecord(body)
  const Icon = TONE_ICON[record.tone]
  const parts = recordSentenceParts(approvalSentence(t, record.sentence), {
    tool: record.tool,
    answer: record.answer ?? nativeChatReceiptCopy(t).unavailable
  })
  const shell = body.detail ? readShellApprovalDetail(body.detail, body.toolName, undefined) : null
  // A prompt with no tool name is named by its whole title, which the line may cut.
  const detail =
    shell?.command ?? (body.detail?.trim() || (body.toolName?.trim() ? null : record.tool))
  const lines = shell?.command.split('\n') ?? []
  // The first line, marked as cut when the command goes on.
  const preview = lines[0] ? `${lines[0].trim()}${lines.length > 1 ? '…' : ''}` : null
  const sentence = parts.map((part) => part.text).join('')
  return (
    <MobileNativeChatEventRow
      icon={<Icon size={14} color={colors.textMuted} strokeWidth={2} />}
      label={preview ? `${sentence} · ${preview}` : sentence}
      timestamp={body.resolution.resolvedAt}
      disclosureKey={disclosureKey}
      fontScale={fontScale}
      details={
        detail ? (
          <Text
            selectable
            style={[
              styles.detail,
              shell
                ? [styles.code, scaledType(MONO_SIZE, fontScale)]
                : scaledType(typography.metaSize, fontScale)
            ]}
          >
            {detail}
          </Text>
        ) : null
      }
    >
      {parts.map((part) =>
        part.name ? (
          <MobileNativeChatEventName key={part.name}>{part.text}</MobileNativeChatEventName>
        ) : (
          part.text
        )
      )}
      {preview ? ` · ${preview}` : null}
    </MobileNativeChatEventRow>
  )
}

/** "You answered: Fix the test", each question and its answer below it. */
function QuestionRecord({
  body,
  disclosureKey,
  fontScale
}: {
  body: AgentJournalQuestionItem
  disclosureKey?: string
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const copy = nativeChatReceiptCopy(t)
  const subject = nativeChatReceiptSubject(body)
  const answers = nativeChatReceiptAnswers(body)
  const cancelled = body.resolution.state === 'cancelled'
  if (!cancelled && answers.length === 0) {
    return (
      <MobileNativeChatAwaitingInputRow
        subject={subject}
        pending={false}
        fontScale={fontScale}
        disclosureKey={disclosureKey}
      />
    )
  }
  const answerText = (answer: NativeChatReceiptAnswer) =>
    answer.answer === '' ? copy.emptyAnswer : (answer.answer ?? copy.unavailable)
  const parts = cancelled
    ? [{ text: copy.questionCancelled, name: null }]
    : answers.length === 1
      ? recordSentenceParts(
          t(
            'chat.receipt.youAnswered',
            'You answered: <answer>{{answer}}</answer>',
            RECORD_SENTENCE_KEEP
          ),
          { answer: answerText(answers[0]!) }
        )
      : recordSentenceParts(copy.answeredCount(answers.length), {})
  const type = scaledType(typography.metaSize, fontScale)
  const subjectText = subject?.kind === 'question' ? subject.text : null
  return (
    <MobileNativeChatEventRow
      icon={<MobileNativeChatAskMark />}
      label={parts.map((part) => part.text).join('')}
      timestamp={body.resolution.resolvedAt}
      disclosureKey={disclosureKey}
      fontScale={fontScale}
      details={
        cancelled ? (
          subject ? (
            <AskQuestions
              questions={subject.kind === 'question' ? [subject.text] : subject.questions}
              fontScale={fontScale}
            />
          ) : null
        ) : (
          answers.map((answer) => {
            const question = nativeChatReceiptAnswerHeading(null, answer) ?? subjectText
            return (
              <View key={answer.key}>
                {question ? (
                  <MobileNativeChatQuestionText
                    content={question}
                    fontSize={type.fontSize}
                    tone="muted"
                    rangeSelectable
                  />
                ) : null}
                <Text selectable={INLINE_TEXT_SELECTION} style={[styles.answer, type]}>
                  {answerText(answer)}
                </Text>
              </View>
            )
          })
        )
      }
    >
      {parts.map((part) =>
        part.name ? (
          <MobileNativeChatEventName key={part.name}>{part.text}</MobileNativeChatEventName>
        ) : (
          part.text
        )
      )}
    </MobileNativeChatEventRow>
  )
}

/** A plan review's full receipt: the plan's title and text, the answer and who gave it. */
function PlanReceipt({
  body,
  fontScale
}: {
  body: AgentJournalApprovalItem
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { resolution } = body
  const device = nativeChatReceiptDevice(resolution, {
    current: t('chat.receipt.thisPhone', 'this phone'),
    computer: t('chat.receipt.computer', 'the computer'),
    unknown: t('chat.receipt.otherDevice', 'another device')
  })
  const copy = nativeChatReceiptCopy(t, device)
  const cancelled = resolution.state === 'cancelled'
  const outcome = [
    cancelled ? copy.cancelled : copy.resolved,
    resolution.resolvedBy ? (cancelled ? copy.cancelledBy : copy.resolver) : null
  ]
  const text = [styles.muted, scaledType(typography.metaSize, fontScale, 5)]
  return (
    <View style={styles.receipt}>
      <Text selectable={INLINE_TEXT_SELECTION} style={[text, styles.title]}>
        {body.displayName ?? body.title}
      </Text>
      {body.detail ? (
        <Text selectable={INLINE_TEXT_SELECTION} style={text} numberOfLines={3}>
          {body.detail}
        </Text>
      ) : null}
      {nativeChatReceiptAnswers(body).map((answer) => (
        <Text key={answer.key} selectable={INLINE_TEXT_SELECTION} style={text} numberOfLines={3}>
          {answer.answer ?? copy.unavailable}
        </Text>
      ))}
      <View style={styles.outcome}>
        <Text style={text}>{outcome.filter(Boolean).join(' · ')}</Text>
        <MobileNativeChatMessageTime timestamp={resolution.resolvedAt} fontScale={fontScale} />
      </View>
    </View>
  )
}

function approvalSentence(t: Translate, sentence: OwnApprovalRecordSentence): string {
  switch (sentence) {
    case 'cancelled':
      return t(
        'chat.approvalRecord.cancelled',
        'Request for <tool>{{tool}}</tool> cancelled',
        RECORD_SENTENCE_KEEP
      )
    case 'coordinatorAllowed':
      return t(
        'chat.approvalRecord.coordinatorAllowed',
        'Coordinator allowed <tool>{{tool}}</tool>',
        RECORD_SENTENCE_KEEP
      )
    case 'coordinatorDenied':
      return t(
        'chat.approvalRecord.coordinatorDenied',
        'Coordinator denied <tool>{{tool}}</tool>',
        RECORD_SENTENCE_KEEP
      )
    case 'allowedUnnamed':
      return t(
        'chat.approvalRecord.allowedUnnamed',
        'Allowed <tool>{{tool}}</tool>',
        RECORD_SENTENCE_KEEP
      )
    case 'deniedUnnamed':
      return t(
        'chat.approvalRecord.deniedUnnamed',
        'Denied <tool>{{tool}}</tool>',
        RECORD_SENTENCE_KEEP
      )
    case 'youAllowed':
      return t(
        'chat.approvalRecord.youAllowed',
        'You allowed <tool>{{tool}}</tool>',
        RECORD_SENTENCE_KEEP
      )
    case 'youAllowedForSession':
      return t(
        'chat.approvalRecord.youAllowedForSession',
        'You allowed <tool>{{tool}}</tool> for this session',
        RECORD_SENTENCE_KEEP
      )
    case 'youDenied':
      return t(
        'chat.approvalRecord.youDenied',
        'You denied <tool>{{tool}}</tool>',
        RECORD_SENTENCE_KEEP
      )
    case 'youAnswered':
      return t(
        'chat.approvalRecord.youAnswered',
        'You answered <tool>{{tool}}</tool>: <answer>{{answer}}</answer>',
        RECORD_SENTENCE_KEEP
      )
  }
}

const styles = themedStyleSheet(() => ({
  detail: { color: colors.textSecondary },
  code: { fontFamily: typography.monoFamily },
  answer: { color: colors.textPrimary },
  receipt: {
    gap: spacing.xs,
    paddingLeft: spacing.md,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle
  },
  muted: { color: colors.textMuted },
  title: { fontWeight: '600' },
  outcome: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }
}))
