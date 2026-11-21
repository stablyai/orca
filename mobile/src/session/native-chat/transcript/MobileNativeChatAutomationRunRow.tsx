import { useContext, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight } from '../../../components/icons/app-icons'
import type { AutomationRunMessage } from '../../../../../src/shared/automations/automation-run-message'
import { automationRunInstructions } from '../../../../../src/shared/automations/automation-run-message'
import {
  automationRunAccess,
  automationRunEventCopyText,
  automationRunEventLink,
  automationRunFacts,
  automationRunLabel,
  automationRunQuoteAuthor,
  sayAutomationRunEnglish,
  type AutomationRunResend,
  type AutomationRunRowState,
  type AutomationRunWording
} from '../../../../../src/shared/automations/automation-run-row-words'
import {
  mergedRunFailures,
  type MergedRunFailure
} from '../../../../../src/shared/native-chat/transcript/events/native-chat-event-plan'
import { botAutomationWhenParts } from '../../../../../src/shared/bots/bot-automation-when'
import { formatAutomationScheduleDescriptor } from '../../../automations/automation-schedule-label'
import { MobileSourceCopyButton } from '../../../components/code-presentation/MobileSourceCopyButton'
import { automationRunMark } from '../../../../../src/shared/automations/automation-chat-row'
import { colors, typography } from '../../../theme/mobile-theme'
import { openExternalLink } from '../../../platform/external-links/external-link'
import { MobileAutomationRunInstructions } from './MobileAutomationRunInstructions'
import { scaledType, styles as chat } from './messages/mobile-native-chat-message-styles'
import { mobileNativeChatRowId } from './viewport/mobile-native-chat-reading-place'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { styles } from './mobile-automation-run-row-styles'
import { MobileNativeChatBotIdentityContext } from '../mobile-native-chat-bot-identity'
import { useMobileBotCardHost } from './bot-cards/mobile-bot-card-host'
import { MobileNativeChatNoticePill } from './notices/MobileNativeChatNoticePill'
import { botRunSendAgain } from '../../../bots/bot-sheet-operations'
import { mobileBotRefusalText } from '../../../bots/mobile-bot-refusal-text'
import { triggerError } from '../../../platform/haptics/haptics'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  MobileAutomationRowFrame,
  mobileAutomationRowTime as time
} from './MobileAutomationRowFrame'

/** An automation's row wording, in English: a run's as saved when it ran, or the automation's own. */
export function useMobileAutomationRowWording(
  automation: Pick<AutomationRunMessage['automation'], 'dtstart' | 'rrule' | 'on'>
): AutomationRunWording {
  return useMemo(() => {
    const schedule = botAutomationWhenParts(automation).find((part) => part.kind === 'schedule')
    return {
      say: sayAutomationRunEnglish,
      formatTime: time,
      schedule:
        schedule?.kind === 'schedule' ? formatAutomationScheduleDescriptor(schedule.schedule) : ''
    }
  }, [automation])
}

/** The send's error, or why its chat was refused in chat's words; the phone's copy names no computer. */
function startErrorText(failure: Pick<MergedRunFailure, 'error' | 'refusal'>): string {
  return failure.refusal ? mobileBotRefusalText(failure.refusal) : failure.error
}

/** A transcript message that is an automation's run, or one no chat took, as its row. */
export function MobileAutomationRunMessage({
  message,
  rowKey,
  fontScale
}: {
  message: NativeChatMessage
  rowKey?: string
  fontScale: number
}): React.JSX.Element | null {
  const notStarted = message.automationRunNotStarted
  const run = notStarted?.run ?? message.automationRun
  if (!run) {
    return null
  }
  const text =
    notStarted?.text ??
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  return (
    <View style={chat.row} testID={mobileNativeChatRowId(rowKey ?? message.id)}>
      <MobileNativeChatAutomationRunRow
        messageId={message.id}
        run={run}
        state={notStarted ? 'not-started' : message.queued ? 'queued' : 'ran'}
        text={text}
        timestamp={message.timestamp}
        {...(notStarted
          ? { error: startErrorText(notStarted), resend: notStarted.sentAgain ? 'sent' : 'offer' }
          : {})}
        earlierFailures={mergedRunFailures(message)}
        fontScale={fontScale}
      />
    </View>
  )
}

/** An automation's run as a status row: "<trigger> · <name>", or "Couldn't start <name>". Opens in place
 *  to its error, instructions and the event. */
export function MobileNativeChatAutomationRunRow({
  messageId,
  run,
  state,
  text,
  timestamp,
  error,
  resend = 'none',
  earlierFailures,
  fontScale
}: {
  messageId: string
  run: AutomationRunMessage
  state: AutomationRunRowState
  text: string
  timestamp: number | null
  error?: string
  /** Whether Send again is offered here, or already went. */
  resend?: AutomationRunResend
  /** Earlier tries of this run that couldn't start, merged into its row, newest first. */
  earlierFailures?: readonly MergedRunFailure[]
  fontScale: number
}): React.JSX.Element {
  const wording = useMobileAutomationRowWording(run.automation)
  const { say } = wording
  const notStarted = state === 'not-started'
  const instructions = automationRunInstructions(text, run)
  const facts = automationRunFacts(run, timestamp, wording)
  const meta = scaledType(typography.metaSize, fontScale, 4)
  const { event } = run
  const access = event ? automationRunAccess(event, say) : null
  const link = event ? automationRunEventLink(event, say) : null
  const [sendError, setSendError] = useState<string | null>(null)
  return (
    <>
      <MobileAutomationRowFrame
        testID="automation-run-row"
        mark={automationRunMark(run)}
        lead={notStarted ? say('couldNotStart') : automationRunLabel(run, say)}
        leadIsVerb={notStarted}
        name={run.automation.name}
        status={state === 'queued' ? say('queued') : null}
        failed={notStarted}
        timestamp={timestamp}
        disclosureKey={`automation-run:${messageId}`}
        action={
          notStarted ? (
            <MobileAutomationSendAgain
              run={run}
              resend={resend}
              wording={wording}
              metaStyle={meta}
              onError={setSendError}
            />
          ) : null
        }
        fontScale={fontScale}
      >
        <>
          {error ? (
            <>
              <Text style={[styles.heading, meta]}>{say('startError')}</Text>
              <Text selectable style={[styles.error, meta]}>
                {error}
              </Text>
            </>
          ) : null}
          {earlierFailures?.map((failure) => (
            <View key={failure.id}>
              <Text style={[styles.heading, meta]}>
                {[say('couldNotStart'), failure.timestamp ? time(failure.timestamp) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Text selectable style={[styles.error, meta]}>
                {startErrorText(failure)}
              </Text>
            </View>
          ))}
          {instructions ? (
            <>
              <Text style={[styles.heading, meta]}>{say('instructions')}</Text>
              <MobileAutomationRunInstructions
                messageId={messageId}
                instructions={instructions}
                fontScale={fontScale}
                say={say}
              />
              <View style={styles.actions}>
                <MobileSourceCopyButton
                  text={instructions}
                  accessibilityLabel={say('copyInstructions')}
                />
                <Text style={[styles.meta, meta]}>{say('copyInstructions')}</Text>
              </View>
            </>
          ) : null}
          {facts || event?.text ? <Text style={[styles.heading, meta]}>{say('event')}</Text> : null}
          {facts ? <Text style={[styles.meta, meta]}>{facts}</Text> : null}
          {link ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => openExternalLink(link.url)}
              style={styles.linkRow}
            >
              <Text style={[styles.link, meta]}>{link.label}</Text>
              <ArrowUpRight size={12} color={colors.textSecondary} />
            </Pressable>
          ) : null}
          {event?.text ? (
            <>
              {/* Provenance first, so a long quote can't push it out of view. */}
              <Text style={[styles.meta, meta]}>{say('external')}</Text>
              <View style={styles.quote}>
                <Text style={[styles.meta, meta]}>{automationRunQuoteAuthor(event, say)}</Text>
                <Text selectable style={[styles.quoteText, scaledType(15, fontScale, 6)]}>
                  {event.text}
                </Text>
              </View>
              {event.textShortened ? (
                <Text style={[styles.meta, meta]}>{say('shortened')}</Text>
              ) : null}
              {access ? <Text style={[styles.meta, meta]}>{access}</Text> : null}
              <View style={styles.actions}>
                <MobileSourceCopyButton
                  text={automationRunEventCopyText(facts, event, say)}
                  accessibilityLabel={say('copyEvent')}
                />
                <Text style={[styles.meta, meta]}>{say('copyEvent')}</Text>
              </View>
            </>
          ) : null}
        </>
      </MobileAutomationRowFrame>
      {sendError && resend !== 'sent' ? (
        <Text style={[styles.sendAgainError, meta]}>{sendError}</Text>
      ) : null}
    </>
  )
}

/** Sends a wait's run that couldn't start once more, as the desktop's row does; says Sent again after. */
function MobileAutomationSendAgain({
  run,
  resend,
  wording,
  metaStyle,
  onError
}: {
  run: AutomationRunMessage
  resend: AutomationRunResend
  wording: AutomationRunWording
  metaStyle: ReturnType<typeof scaledType>
  /** The host's refusal, or null as a new send starts. */
  onError: (error: string | null) => void
}): React.JSX.Element | null {
  const { say } = wording
  const t = useMobileTranslation()
  const bot = useContext(MobileNativeChatBotIdentityContext)
  const client = useMobileBotCardHost()?.client ?? null
  const [sending, setSending] = useState<'idle' | 'busy' | 'sent'>('idle')
  if (resend === 'none' || run.wait === undefined || !bot?.botId || !bot.sessionId || !client) {
    return null
  }
  if (sending === 'sent' || resend === 'sent') {
    return <Text style={[styles.meta, metaStyle]}>{say('sentAgain')}</Text>
  }
  const { botId, sessionId } = bot
  return (
    <MobileNativeChatNoticePill
      label={say('sendAgain')}
      disabled={sending === 'busy'}
      onPress={() => {
        setSending('busy')
        onError(null)
        void botRunSendAgain
          .request(client, { botId, sessionId, runId: run.runId })
          .then((reply) => {
            botRunSendAgain.interpret(reply)
            setSending('sent')
          })
          .catch(() => {
            triggerError()
            setSending('idle')
            // As the desktop: the host's refusals are codes, not sentences for the owner.
            onError(t('bots.errors.generic', 'Something went wrong. Try again.'))
          })
      }}
    />
  )
}
