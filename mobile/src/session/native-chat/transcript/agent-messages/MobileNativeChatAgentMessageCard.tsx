import { useNativeChatProseText } from '../../preferences/native-chat-text-settings'
import { Fragment, memo, useContext, useMemo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight, Bot } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  agentMessageSendersShown,
  type AgentMessageSource
} from '../../../../../../src/shared/agent-session/journal/agent-session-message-source'
import {
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageCanCopy,
  agentMessageSenderCanOpen,
  agentMessageWaitingQueuedId,
  agentMessageHeadingNamesRecipient,
  type AgentMessageHeading
} from '../../../../../../src/shared/agent-session/view/messages/agent-message-presentation'
import { agentMessagePreviewLine } from '../../../../../../src/shared/agent-session/view/messages/agent-message-preview-line'
import { mobileNativeChatDisplayCopyText } from '../messages/mobile-native-chat-display-copy'
import { MobileNativeChatMarkdown } from '../message-content/MobileNativeChatMarkdown'
import { MobileNativeChatMessageTime } from '../messages/MobileNativeChatMessageTime'
import { MobileAgentIcon } from '../../../../components/icons/MobileAgentIcon'
import { MobileSourceCopyButton } from '../../../../components/code-presentation/MobileSourceCopyButton'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { pressedStyle, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import {
  MobileAgentMessageOpenContext,
  useMobileAgentMessageName,
  useMobileAgentMessageView
} from './mobile-agent-message-context'
import { MobileWaitingAgentMailActions } from './MobileWaitingAgentMailActions'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from '../messages/MobileNativeChatEventRow'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'

type Sender = AgentMessageSource['senders'][number]

/** The full lead read before the name: the row's spoken label, and the merged-entry word when
 *  `standalone` (a lead with no name after it). */
export function mobileAgentMessageLead(
  heading: AgentMessageHeading,
  t: Translate,
  standalone = false
): string {
  switch (heading) {
    case 'started':
    case 'started-agent':
      return standaloneWords(t('chat.agentMessage.row.started', 'Started'), standalone)
    case 'reopened-worker':
      return standaloneWords(t('chat.agentMessage.row.reopened', 'Reopened'), standalone)
    case 'followed-up-worker':
      return standalone
        ? t('chat.agentMessage.event.followedUp', 'Sent follow-up')
        : t('chat.agentMessage.row.followedUp', 'Sent follow-up to')
    case 'handed-off':
      return standalone
        ? t('chat.agentMessage.event.handedOff', 'Handed off')
        : t('chat.agentMessage.row.handedOff', 'Handed off to')
    case 'task':
      return standalone
        ? t('chat.agentMessage.event.task', 'Task')
        : t('chat.agentMessage.row.task', 'Task from')
    case 'worker':
      return standalone
        ? t('chat.agentMessage.event.update', 'Update')
        : t('chat.agentMessage.row.update', 'Update from')
    case 'coordinator':
    case 'generic':
      return standalone
        ? t('chat.agentMessage.event.message', 'Message')
        : t('chat.agentMessage.row.message', 'Message from')
  }
}

/** A start or reopen lead reads whole on its own; one that joins a name with a colon ("再開:")
 *  drops it when no name follows. */
function standaloneWords(words: string, standalone: boolean): string {
  return standalone ? words.replace(/\s*[:：]\s*$/u, '') : words
}

/** Stands in for a missing name: a follow-up or a hand-off names who received it, so it takes the
 *  recipient form; every other heading keeps the sender-form fallback it always used. */
export function mobileAgentMessageUnnamed(heading: AgentMessageHeading, t: Translate): string {
  return agentMessageHeadingNamesRecipient(heading)
    ? t('chat.agentMessage.unnamedRecipient', 'an agent')
    : t('session.agentMessageAttribution.unnamedSender', 'an agent')
}

/** The one word drawn before the name for a start, a hand-off or a task; a plain message draws none. */
function kindWord(heading: AgentMessageHeading, t: Translate): string | null {
  switch (heading) {
    case 'started':
    case 'started-agent':
      return t('chat.agentMessage.kind.started', 'Started')
    case 'reopened-worker':
      return t('chat.agentMessage.kind.reopened', 'Reopened')
    case 'followed-up-worker':
      return t('chat.agentMessage.kind.followedUp', 'Follow-up')
    case 'handed-off':
      return t('chat.agentMessage.kind.handedOff', 'Handed off')
    case 'task':
      return t('chat.agentMessage.kind.task', 'Task')
    case 'worker':
    case 'coordinator':
    case 'generic':
      return null
  }
}

type AgentMessageCardProps = {
  message: NativeChatMessage
  from: AgentMessageSource
  fontScale: number
  attachments: React.ReactNode
  onLongPress?: () => void
  status?: React.ReactNode
}

/** A message between agents (a start, a task, a worker's update) as one status row: the sender's agent
 *  mark with its live state, a kind word for a start or a task, the name, the message's first line, the
 *  open icon, and the whole message opening below. */
export const MobileNativeChatAgentMessageCard = memo(function MobileNativeChatAgentMessageCard({
  message,
  from,
  fontScale,
  attachments,
  onLongPress,
  status
}: AgentMessageCardProps) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const prose = useNativeChatProseText(fontScale)
  // A sender's status change redraws the row; the body's text and first line are read once per body.
  const text = useMemo(() => mobileNativeChatDisplayCopyText(message), [message])
  const sender = agentMessagePrimarySender(from)
  const heading = agentMessageHeading(from, message)
  const unnamed = mobileAgentMessageUnnamed(heading, t)
  const senderName = useMobileAgentMessageName(sender) ?? unnamed
  const view = useMobileAgentMessageView(sender)
  const { shown, more } = agentMessageSendersShown(from)
  const words = mobileAgentMessageLead(heading, t)
  const kind = kindWord(heading, t)
  const preview = useMemo(() => agentMessagePreviewLine(text).line, [text])
  const items = message.agentStartItems ?? []
  const merged = message.mergedEvents ?? []
  const canCopy = agentMessageCanCopy(text)
  // Mail from several senders opens each from its details.
  const several = shown.length > 1
  // Not taken by the agent yet: dimmed, with no time, until its delivered row replaces it in place.
  const waiting = message.queued === true
  // A row with details is a button VoiceOver names by its label, which says a waiting one is not sent yet.
  const expandable =
    waiting ||
    canCopy ||
    several ||
    merged.length > 0 ||
    message.blocks.some((block) => block.type === 'image-ref')
  const waitingId = agentMessageWaitingQueuedId(message)
  const openSender =
    sender && !several ? <OpenSender from={from} sender={sender} unnamed={unnamed} /> : null
  const row = (
    <MobileNativeChatEventRow
      testID={waiting ? 'agent-message-card-waiting' : 'agent-message-card'}
      // The first line wraps once beside the open button, chevron and time.
      wordsLines={2}
      icon={<SenderMark agentType={view.agentType} />}
      // The live state never marks a row failed: a restarted worker would un-fail it. Waiting mail shows no status.
      badge={!waiting && view.dot === 'working' ? 'running' : null}
      label={`${words} ${senderName}${from.senders.length > 1 ? ` +${from.senders.length - 1}` : ''}${
        items.length > 0
          ? ` ${t('chat.agentMessage.row.forItems', 'for')} ${items.map((item) => item.title).join(', ')}`
          : ''
      }${waiting ? `, ${t('chat.agentMessage.row.notSentYet', 'not sent yet')}` : ''}${
        preview ? `: ${preview}` : ''
      }`}
      action={
        waitingId ? (
          <View style={styles.waitingActions}>
            {openSender}
            <MobileWaitingAgentMailActions queuedMessageId={waitingId} />
          </View>
        ) : (
          openSender
        )
      }
      timestamp={waiting ? null : message.timestamp}
      disclosureKey={`agent-message:${message.queuedMessageId ?? message.id}`}
      fontScale={fontScale}
      onLongPress={onLongPress}
      details={
        expandable ? (
          <>
            {several ? (
              <View style={styles.senders}>
                {shown.map((each) => (
                  <OpenSender
                    key={each.party.address}
                    from={from}
                    sender={each}
                    unnamed={unnamed}
                    named
                    recipient={agentMessageHeadingNamesRecipient(heading)}
                  />
                ))}
              </View>
            ) : null}
            {attachments}
            <MobileNativeChatMarkdown
              content={text}
              rangeSelectable
              {...prose}
              onLongPress={onLongPress}
            />
            {status}
            {merged.map((earlier) => {
              const earlierHeading = earlier.from && agentMessageHeading(earlier.from, earlier)
              const earlierText = mobileNativeChatDisplayCopyText(earlier)
              return (
                <View key={earlier.id} style={styles.mergedEntry}>
                  <View style={styles.mergedMeta}>
                    {earlierHeading && mobileAgentMessageLead(earlierHeading, t) !== words ? (
                      <Text style={styles.mergedWords}>
                        {mobileAgentMessageLead(earlierHeading, t, true)}
                      </Text>
                    ) : null}
                    {earlier.agentStartItems?.length ? (
                      <Text style={styles.mergedWords}>
                        {`${t('chat.agentMessage.row.forItems', 'for')} ${earlier.agentStartItems
                          .map((item) => item.title)
                          .join(', ')}`}
                      </Text>
                    ) : null}
                    <MobileNativeChatMessageTime
                      timestamp={earlier.timestamp}
                      fontScale={fontScale}
                    />
                  </View>
                  {earlierText.trim() ? (
                    <MobileNativeChatMarkdown
                      content={earlierText}
                      rangeSelectable
                      {...prose}
                      onLongPress={onLongPress}
                    />
                  ) : null}
                </View>
              )
            })}
            {canCopy ? (
              <View style={styles.copy}>
                <MobileSourceCopyButton
                  text={text}
                  accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
                />
              </View>
            ) : null}
          </>
        ) : null
      }
    >
      {(open) => (
        <>
          {kind ? `${kind} ` : null}
          {shown.length === 0
            ? unnamed
            : shown.map((shownSender, index) => (
                <Fragment key={shownSender.party.address}>
                  {index > 0 ? ', ' : null}
                  <SenderName sender={shownSender} unnamed={unnamed} />
                </Fragment>
              ))}
          {more > 0 ? ` +${more}` : null}
          {items.length > 0 ? (
            <>
              {` ${t('chat.agentMessage.row.forItems', 'for')} `}
              <MobileNativeChatEventName>
                {items.map((item) => item.title).join(', ')}
              </MobileNativeChatEventName>
            </>
          ) : null}
          {/* The open message shows its first line itself. */}
          {preview && !open ? ` ${preview}` : null}
        </>
      )}
    </MobileNativeChatEventRow>
  )
  return waiting ? <View style={styles.waiting}>{row}</View> : row
})

function SenderName({ sender, unnamed }: { sender: Sender; unnamed: string }) {
  return (
    <MobileNativeChatEventName>
      {useMobileAgentMessageName(sender) ?? unnamed}
    </MobileNativeChatEventName>
  )
}

/** Opens the sender's chat or terminal, where this phone can open one. */
function OpenSender({
  from,
  sender,
  unnamed,
  named = false,
  recipient = false
}: {
  from: AgentMessageSource
  sender: Sender
  unnamed: string
  /** Its name beside the icon, for mail from several senders. */
  named?: boolean
  /** The name stands alone for who received it; German says "an Eule". */
  recipient?: boolean
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const open = useContext(MobileAgentMessageOpenContext)
  const name = useMobileAgentMessageName(sender)
  if (!open || !agentMessageSenderCanOpen(sender)) {
    return null
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chat.agentMessage.open', 'Open {{name}}', {
        name: name ?? t('session.agentMessageAttribution.unnamedSender', 'an agent')
      })}
      hitSlop={named ? 8 : 12}
      onPress={() => open(from, sender)}
      style={({ pressed }) => [named && styles.named, pressed && pressedStyle]}
    >
      {named ? (
        <Text numberOfLines={1} style={styles.namedText}>
          {recipient
            ? t('chat.agentMessage.recipientName', '{{name}}', { name: name ?? unnamed })
            : (name ?? unnamed)}
        </Text>
      ) : null}
      <ArrowUpRight size={14} color={named ? colors.textPrimary : colors.textMuted} />
    </Pressable>
  )
}

/** The sender's own agent mark. */
function SenderMark({
  agentType
}: {
  agentType: ReturnType<typeof useMobileAgentMessageView>['agentType']
}) {
  const colors = useMobileColors()
  return agentType ? (
    <MobileAgentIcon agentId={agentType} size={14} />
  ) : (
    <Bot size={14} color={colors.textMuted} strokeWidth={2} />
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  copy: { alignSelf: 'flex-start' },
  waiting: { opacity: 0.7 },
  waitingActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  mergedEntry: { gap: spacing.xs },
  mergedMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  mergedWords: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  senders: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  named: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs, maxWidth: '100%' },
  namedText: { flexShrink: 1, color: colors.textPrimary, fontSize: typography.metaSize }
}))
