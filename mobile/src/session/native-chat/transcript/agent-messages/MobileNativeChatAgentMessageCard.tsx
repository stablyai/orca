import { useNativeChatProseText } from '../../preferences/native-chat-text-settings'
import { Fragment, memo, useContext } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight, Bot } from '../../../../components/icons/app-icons'
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
  type AgentMessageHeading
} from '../../../../../../src/shared/agent-session/view/messages/agent-message-presentation'
import { mobileNativeChatDisplayCopyText } from '../messages/mobile-native-chat-display-copy'
import { MobileNativeChatMarkdown } from '../message-content/MobileNativeChatMarkdown'
import { MobileNativeChatMessageTime } from '../messages/MobileNativeChatMessageTime'
import { MobileAgentIcon } from '../../../../components/icons/MobileAgentIcon'
import { MobileSourceCopyButton } from '../../../../components/code-presentation/MobileSourceCopyButton'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { colors, pressedStyle, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import {
  MobileAgentMessageOpenContext,
  useMobileAgentMessageName,
  useMobileAgentMessageView
} from './mobile-agent-message-context'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from '../messages/MobileNativeChatEventRow'

type Sender = AgentMessageSource['senders'][number]

function lead(heading: AgentMessageHeading, t: Translate): string {
  switch (heading) {
    case 'started':
    case 'started-agent':
      return t('chat.agentMessage.row.started', 'Started')
    case 'reopened-worker':
      return t('chat.agentMessage.row.reopened', 'Reopened')
    case 'followed-up-worker':
      return t('chat.agentMessage.row.followedUp', 'Sent follow-up to')
    case 'handed-off':
      return t('chat.agentMessage.row.handedOff', 'Handed off to')
    case 'task':
      return t('chat.agentMessage.row.task', 'Task from')
    case 'worker':
      return t('chat.agentMessage.row.update', 'Update from')
    case 'coordinator':
    case 'generic':
      return t('chat.agentMessage.row.message', 'Message from')
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
 *  mark with its live state, "Update from <name>", the open icon, and the message opening below. */
export const MobileNativeChatAgentMessageCard = memo(function MobileNativeChatAgentMessageCard({
  message,
  from,
  fontScale,
  attachments,
  onLongPress,
  status
}: AgentMessageCardProps) {
  const t = useMobileTranslation()
  const prose = useNativeChatProseText(fontScale)
  const text = mobileNativeChatDisplayCopyText(message)
  const sender = agentMessagePrimarySender(from)
  const unnamed = t('session.agentMessageAttribution.unnamedSender', 'an agent')
  const senderName = useMobileAgentMessageName(sender ?? NO_SENDER, unnamed)
  const view = useMobileAgentMessageView(sender)
  const { shown, more } = agentMessageSendersShown(from)
  const words = lead(agentMessageHeading(from, message), t)
  const items = message.agentStartItems ?? []
  const merged = message.mergedEvents ?? []
  const canCopy = agentMessageCanCopy(text)
  // Mail from several senders opens each from its details.
  const several = shown.length > 1
  const expandable =
    canCopy ||
    several ||
    merged.length > 0 ||
    message.blocks.some((block) => block.type === 'image-ref')
  return (
    <MobileNativeChatEventRow
      testID="agent-message-card"
      icon={<SenderMark agentType={view.agentType} />}
      // The live state never marks a row failed: a restarted worker would un-fail it.
      badge={view.dot === 'working' ? 'running' : null}
      label={`${words} ${sender ? senderName : unnamed}${more > 0 ? ` +${more}` : ''}${
        items.length > 0
          ? ` ${t('chat.agentMessage.row.forItems', 'for')} ${items.map((item) => item.title).join(', ')}`
          : ''
      }`}
      action={
        sender && !several ? <OpenSender from={from} sender={sender} unnamed={unnamed} /> : null
      }
      timestamp={message.timestamp}
      disclosureKey={`agent-message:${message.id}`}
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
              const earlierWords = earlier.from
                ? lead(agentMessageHeading(earlier.from, earlier), t)
                : null
              const earlierText = mobileNativeChatDisplayCopyText(earlier)
              return (
                <View key={earlier.id} style={styles.mergedEntry}>
                  <View style={styles.mergedMeta}>
                    {earlierWords && earlierWords !== words ? (
                      <Text style={styles.mergedWords}>{earlierWords}</Text>
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
      {words}{' '}
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
    </MobileNativeChatEventRow>
  )
})

/** Stands in so the name hook runs in every render; its answer is unused without a sender. */
const NO_SENDER: Sender = {
  party: { address: '', terminalHandle: null, orcaSessionId: null },
  name: null
}

function SenderName({ sender, unnamed }: { sender: Sender; unnamed: string }) {
  return (
    <MobileNativeChatEventName>
      {useMobileAgentMessageName(sender, unnamed)}
    </MobileNativeChatEventName>
  )
}

/** Opens the sender's chat or terminal, where this phone can open one. */
function OpenSender({
  from,
  sender,
  unnamed,
  named = false
}: {
  from: AgentMessageSource
  sender: Sender
  unnamed: string
  /** Its name beside the icon, for mail from several senders. */
  named?: boolean
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const open = useContext(MobileAgentMessageOpenContext)
  const name = useMobileAgentMessageName(sender, unnamed)
  if (!open || !agentMessageSenderCanOpen(sender)) {
    return null
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chat.agentMessage.open', 'Open {{name}}', { name })}
      hitSlop={named ? 8 : 12}
      onPress={() => open(from, sender)}
      style={({ pressed }) => [named && styles.named, pressed && pressedStyle]}
    >
      {named ? (
        <Text numberOfLines={1} style={styles.namedText}>
          {name}
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
  return agentType ? (
    <MobileAgentIcon agentId={agentType} size={14} />
  ) : (
    <Bot size={14} color={colors.textMuted} strokeWidth={2} />
  )
}

const styles = themedStyleSheet(() => ({
  copy: { alignSelf: 'flex-start' },
  mergedEntry: { gap: spacing.xs },
  mergedMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  mergedWords: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  senders: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  named: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs, maxWidth: '100%' },
  namedText: { flexShrink: 1, color: colors.textPrimary, fontSize: typography.metaSize }
}))
