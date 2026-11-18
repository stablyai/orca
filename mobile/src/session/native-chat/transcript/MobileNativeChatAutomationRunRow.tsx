import { useMemo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import type { AutomationRunMessage } from '../../../../../src/shared/automations/automation-run-message'
import { automationRunInstructions } from '../../../../../src/shared/automations/automation-run-message'
import {
  automationRunAccess,
  automationRunAccessibleName,
  automationRunEventCopyText,
  automationRunEventLink,
  automationRunFacts,
  automationRunLabel,
  automationRunQuoteAuthor,
  automationRunReason,
  sayAutomationRunEnglish,
  type AutomationRunRowState,
  type AutomationRunWording
} from '../../../../../src/shared/automations/automation-run-row-words'
import { botAutomationWhenParts } from '../../../../../src/shared/bots/bot-automation-when'
import { formatAutomationScheduleDescriptor } from '../../../automations/automation-schedule-label'
import { MobileSourceCopyButton } from '../../../components/code-presentation/MobileSourceCopyButton'
import { automationRunMark } from '../../../../../src/shared/automations/automation-chat-row'
import { colors, typography } from '../../../theme/mobile-theme'
import { openExternalLink } from '../../../platform/external-links/external-link'
import { MobileAutomationRunInstructions } from './MobileAutomationRunInstructions'
import { useMobileNativeChatDisclosure } from './viewport/mobile-native-chat-disclosure-store'
import { scaledType, styles as chat } from './messages/mobile-native-chat-message-styles'
import { mobileNativeChatRowId } from './viewport/mobile-native-chat-reading-place'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { styles } from './mobile-automation-run-row-styles'
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
        {...(notStarted ? { error: notStarted.error } : {})}
        fontScale={fontScale}
      />
    </View>
  )
}

/** A bot automation's run, on the mobile agent card: its name, then what fired and why on a second
 *  line (320 pt can't fit all three on one). Opens in place to its instructions and the event. */
export function MobileNativeChatAutomationRunRow({
  messageId,
  run,
  state,
  text,
  timestamp,
  error,
  fontScale
}: {
  messageId: string
  run: AutomationRunMessage
  state: AutomationRunRowState
  text: string
  timestamp: number | null
  error?: string
  fontScale: number
}): React.JSX.Element {
  const wording = useMobileAutomationRowWording(run.automation)
  const { say } = wording
  const [open, setOpen] = useMobileNativeChatDisclosure(`automation-run:${messageId}`, false)
  const label = automationRunLabel(run, say)
  const reason = automationRunReason(run, state, timestamp, wording)
  const instructions = automationRunInstructions(text, run)
  const facts = automationRunFacts(run, timestamp, wording)
  const meta = scaledType(typography.metaSize, fontScale, 4)
  const { event } = run
  const access = event ? automationRunAccess(event, say) : null
  const link = event ? automationRunEventLink(event, say) : null
  const at = timestamp ? time(timestamp) : null
  return (
    <MobileAutomationRowFrame
      testID="automation-run-row"
      mark={automationRunMark(run)}
      name={run.automation.name}
      meta={[label, reason, at].filter(Boolean).join(' · ')}
      failed={state === 'not-started'}
      accessibilityLabel={automationRunAccessibleName(
        { label, name: run.automation.name, reason, time: at },
        say
      )}
      open={open}
      onToggle={() => setOpen(!open)}
      fontScale={fontScale}
      action={
        instructions ? (
          <MobileSourceCopyButton
            text={instructions}
            accessibilityLabel={say('copyInstructions')}
          />
        ) : null
      }
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
        {instructions ? (
          <>
            <Text style={[styles.heading, meta]}>{say('instructions')}</Text>
            <MobileAutomationRunInstructions
              messageId={messageId}
              instructions={instructions}
              fontScale={fontScale}
              say={say}
            />
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
  )
}
