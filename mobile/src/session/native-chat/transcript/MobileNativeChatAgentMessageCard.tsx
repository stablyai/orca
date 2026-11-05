import { memo, useContext, useState, useRef, useLayoutEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight, Bot, ChevronDown, ChevronUp } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import { agentMessageSendersShown } from '../../../../../src/shared/agent-session/agent-session-message-source'
import {
  AGENT_MESSAGE_FOLDED_LINES,
  agentMessageHeading,
  agentMessageIsCompact,
  agentMessagePrimarySender,
  agentMessageSenderCanOpen,
  agentMessageOverflows,
  agentMessageFoldLabel,
  agentMessageCanCopy,
  type AgentMessageHeading
} from '../../../../../src/shared/agent-session/agent-message-presentation'
import { mobileNativeChatDisplayCopyText } from './mobile-native-chat-display-copy'
import { MobileMarkdown } from '../../../components/MobileMarkdown'
import { MobileAgentIcon } from '../../../components/MobileAgentIcon'
import { AgentStateDot } from '../../../components/AgentStateDot'
import { MobileSourceCopyButton } from '../../../components/MobileSourceCopyButton'
import { MobileEdgeFade } from '../../../components/MobileEdgeFade'
import { styles as markdownStyles } from '../../../components/mobile-markdown-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing, pressedStyle } from '../../../theme/mobile-theme'
import { styles } from './mobile-agent-message-card-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  MobileAgentMessageOpenContext,
  useMobileAgentMessageName,
  useMobileAgentMessageView
} from './mobile-agent-message-context'
import { MobileNativeChatMessageTime } from './MobileNativeChatMessageTime'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { CHAT_PROSE_SCALE } from './mobile-native-chat-message-styles'

export const MobileNativeChatAgentMessageCard = memo(function MobileNativeChatAgentMessageCard(
  props: React.ComponentProps<typeof PreviewAgentMessageCard>
) {
  return agentMessageIsCompact(props.message, props.from) ? (
    <CompactAgentMessageCard {...props} />
  ) : (
    <PreviewAgentMessageCard {...props} />
  )
})

function CompactAgentMessageCard({
  message,
  from,
  fontScale,
  attachments,
  onOpenFile,
  onLongPress,
  status
}: React.ComponentProps<typeof PreviewAgentMessageCard>) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const text = mobileNativeChatDisplayCopyText(message)
  const [open, setOpen] = useMobileNativeChatDisclosure(`agent-message:${message.id}`, false)
  const headings: Record<AgentMessageHeading, string> = {
    started: t('chat.agentMessage.startedWorker', 'Started worker'),
    'handed-off': t('chat.agentMessage.handedOffToAgent', 'Handed off to agent'),
    'started-agent': t('chat.agentMessage.startedAgent', 'Started agent'),
    task: t('chat.agentMessage.taskFromCoordinator', 'Task from coordinator'),
    coordinator: t('chat.agentMessage.messageFromCoordinator', 'Message from coordinator'),
    worker: t('chat.agentMessage.updateFromWorker', 'Update from worker'),
    generic: t('chat.agentMessage.messageFrom', 'Message from')
  }
  const heading = headings[agentMessageHeading(from, message)]
  const expandable =
    agentMessageCanCopy(text) || message.blocks.some((block) => block.type === 'image-ref')
  const Chevron = open ? ChevronUp : ChevronDown
  return (
    <View style={styles.compactCard} testID="agent-message-card">
      <View style={styles.compactHeader}>
        {expandable ? (
          <Pressable
            style={styles.headerToggle}
            accessibilityRole="button"
            accessibilityLabel={heading}
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            onLongPress={onLongPress}
          />
        ) : null}
        <View pointerEvents="none">
          <SenderAvatar compact sender={agentMessagePrimarySender(from)} />
        </View>
        <Text
          pointerEvents="none"
          numberOfLines={1}
          style={[
            styles.meta,
            styles.compactHeading,
            agentMessageSendersShown(from).shown.length > 1 && styles.compactMultipleSenderHeading
          ]}
        >
          {heading}
        </Text>
        <Senders compact from={from} />
        {agentMessageCanCopy(text) ? (
          <MobileSourceCopyButton
            text={text}
            accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
          />
        ) : null}
        {!expandable ? (
          <MobileNativeChatMessageTime timestamp={message.timestamp} fontScale={fontScale} />
        ) : null}
        {expandable ? (
          <View pointerEvents="none">
            <Chevron size={14} color={colors.textMuted} />
          </View>
        ) : null}
      </View>
      {expandable && open ? (
        <View style={styles.compactBody}>
          {attachments}
          <MobileMarkdown
            content={text}
            rangeSelectable
            textScale={CHAT_PROSE_SCALE * fontScale}
            onOpenFile={onOpenFile}
            onLongPress={onLongPress}
          />
          {status}
          <MobileNativeChatMessageTime timestamp={message.timestamp} fontScale={fontScale} />
        </View>
      ) : null}
    </View>
  )
}

const PreviewAgentMessageCard = memo(function PreviewAgentMessageCard({
  message,
  from,
  fontScale,
  attachments,
  onOpenFile,
  onLongPress,
  status
}: {
  message: NativeChatMessage
  from: AgentMessageSource
  fontScale: number
  attachments: React.ReactNode
  onOpenFile?: (path: string) => void
  onLongPress?: () => void
  status?: React.ReactNode
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const text = mobileNativeChatDisplayCopyText(message)
  const [open, setOpen] = useMobileNativeChatDisclosure(`agent-message:${message.id}`, false)
  const [measurement, setMeasurement] = useState({ identity: '', height: 0 })
  const [width, setWidth] = useState(0)
  const identity = JSON.stringify([text, fontScale, width])
  const currentIdentity = useRef(identity)
  useLayoutEffect(() => {
    currentIdentity.current = identity
  }, [identity])
  const measured = measurement.identity === identity
  const height = measured ? measurement.height : 0
  const lineHeight = markdownStyles.paragraph.lineHeight * CHAT_PROSE_SCALE * fontScale
  const overflows = agentMessageOverflows(height, lineHeight)
  const headings: Record<AgentMessageHeading, string> = {
    started: t('chat.agentMessage.startedWorker', 'Started worker'),
    'handed-off': t('chat.agentMessage.handedOffToAgent', 'Handed off to agent'),
    'started-agent': t('chat.agentMessage.startedAgent', 'Started agent'),
    task: t('chat.agentMessage.taskFromCoordinator', 'Task from coordinator'),
    coordinator: t('chat.agentMessage.messageFromCoordinator', 'Message from coordinator'),
    worker: t('chat.agentMessage.updateFromWorker', 'Update from worker'),
    generic: t('chat.agentMessage.messageFrom', 'Message from')
  }
  const heading = headings[agentMessageHeading(from, message)]
  return (
    <View style={styles.card} testID="agent-message-card">
      <SenderAvatar sender={agentMessagePrimarySender(from)} />
      <View style={styles.content}>
        <View style={styles.heading}>
          <Text style={styles.meta}>{heading}</Text>
          <View style={styles.headerActions}>
            {agentMessageCanCopy(text) ? (
              <MobileSourceCopyButton
                text={text}
                accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
              />
            ) : null}
            <MobileNativeChatMessageTime timestamp={message.timestamp} fontScale={fontScale} />
          </View>
        </View>
        <Senders from={from} />
        {attachments}
        <View
          testID="agent-message-viewport"
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          style={{
            position: 'relative',
            overflow: 'hidden',
            height: measured
              ? open
                ? height
                : Math.min(height, lineHeight * AGENT_MESSAGE_FOLDED_LINES)
              : lineHeight * AGENT_MESSAGE_FOLDED_LINES
          }}
        >
          <View
            key={identity}
            testID="agent-message-body"
            style={styles.body}
            onLayout={(event) => {
              const next = event.nativeEvent.layout.height
              if (currentIdentity.current !== identity) {
                return
              }
              setMeasurement((previous) =>
                previous.identity === identity && previous.height === next
                  ? previous
                  : { identity, height: next }
              )
            }}
          >
            <MobileMarkdown
              content={text}
              rangeSelectable
              textScale={CHAT_PROSE_SCALE * fontScale}
              onOpenFile={onOpenFile}
              onLongPress={onLongPress}
            />
          </View>
          {measured && overflows && !open ? (
            <MobileEdgeFade edge="bottom" height={(spacing.xl + spacing.xs) * fontScale} />
          ) : null}
        </View>
        {status}
        {overflows ? (
          <Pressable
            style={({ pressed }) => pressed && pressedStyle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
          >
            <Text style={styles.toggle}>
              {agentMessageFoldLabel(open) === 'expanded'
                ? t('chat.nativeChatUserMessageFold.showLess', 'Show less')
                : t('chat.agentMessage.showMore', 'Show more')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
})

function SenderAvatar({
  sender,
  compact = false
}: {
  sender: AgentMessageSource['senders'][number] | undefined
  compact?: boolean
}) {
  const view = useMobileAgentMessageView(sender)
  return (
    <View style={[styles.avatar, compact && styles.compactAvatar]}>
      {view.agentType ? (
        <MobileAgentIcon agentId={view.agentType} size={16} />
      ) : (
        <Bot size={16} color={colors.textMuted} />
      )}
      {view.dot && view.dot !== 'permission' ? (
        <View style={styles.glyph}>
          <AgentStateDot state={view.dot} />
        </View>
      ) : null}
    </View>
  )
}

function Senders({ from, compact = false }: { from: AgentMessageSource; compact?: boolean }) {
  const open = useContext(MobileAgentMessageOpenContext)
  const t = useMobileTranslation()
  const { shown, more } = agentMessageSendersShown(from)
  const occurrences = new Map<string, number>()
  return (
    <View pointerEvents="box-none" style={[styles.senders, compact && styles.compactSenders]}>
      {shown.length === 0 ? (
        <Text
          pointerEvents={compact ? 'none' : undefined}
          numberOfLines={compact ? 1 : undefined}
          style={styles.name}
        >
          {t('session.agentMessageAttribution.unnamedSender', 'an agent')}
        </Text>
      ) : null}
      {shown.map((sender) => {
        const identity = JSON.stringify(sender.party)
        const occurrence = occurrences.get(identity) ?? 0
        occurrences.set(identity, occurrence + 1)
        return (
          <SenderName
            key={`${identity}:${occurrence}`}
            sender={sender}
            from={from}
            open={open}
            compact={compact}
            shownCount={shown.length}
          />
        )
      })}
      {from.link ? (
        <Text
          pointerEvents={compact ? 'none' : undefined}
          style={[styles.meta, compact && styles.compactLink]}
          numberOfLines={compact ? 1 : 2}
        >
          {t('chat.agentMessage.sessionLink', 'Link')}: {from.link.title}
        </Text>
      ) : null}
      {more > 0 ? (
        <Text
          pointerEvents={compact ? 'none' : undefined}
          style={[styles.meta, compact && styles.compactMoreSenders]}
        >
          +{more}
        </Text>
      ) : null}
    </View>
  )
}

function SenderName({
  sender,
  from,
  open,
  compact,
  shownCount
}: {
  compact: boolean
  shownCount: number
  sender: AgentMessageSource['senders'][number]
  from: AgentMessageSource
  open: React.ContextType<typeof MobileAgentMessageOpenContext>
}) {
  const t = useMobileTranslation()
  const name = useMobileAgentMessageName(
    sender,
    t('session.agentMessageAttribution.unnamedSender', 'an agent')
  )
  const canOpen = open !== undefined && agentMessageSenderCanOpen(sender)
  return (
    <Pressable
      disabled={!canOpen}
      accessibilityRole={canOpen ? 'button' : undefined}
      onPress={() => open?.(from, sender)}
      pointerEvents={canOpen ? 'auto' : 'none'}
      style={({ pressed }) => [
        styles.sender,
        compact && [styles.compactSender, { maxWidth: `${100 / shownCount}%` }],
        pressed && pressedStyle
      ]}
    >
      <Text numberOfLines={compact ? 1 : undefined} style={styles.name}>
        {name}
      </Text>
      {canOpen ? (
        <ArrowUpRight
          size={14}
          color={colors.textPrimary}
          style={compact ? styles.compactSenderArrow : undefined}
        />
      ) : null}
    </Pressable>
  )
}
