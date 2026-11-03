import { memo, useContext, useState, useRef, useLayoutEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight, Bot } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import { agentMessageSendersShown } from '../../../../../src/shared/agent-session/agent-session-message-source'
import {
  AGENT_MESSAGE_FOLDED_LINES,
  agentMessageHeading,
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
import { colors, radii, spacing, typography, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  MobileAgentMessageOpenContext,
  useMobileAgentMessageName,
  useMobileAgentMessageView
} from './mobile-agent-message-context'
import { MobileNativeChatMessageTime } from './MobileNativeChatMessageTime'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'
import { CHAT_PROSE_SCALE } from './mobile-native-chat-message-styles'

export const MobileNativeChatAgentMessageCard = memo(function MobileNativeChatAgentMessageCard({
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

function SenderAvatar({ sender }: { sender: AgentMessageSource['senders'][number] | undefined }) {
  const view = useMobileAgentMessageView(sender)
  return (
    <View style={styles.avatar}>
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

function Senders({ from }: { from: AgentMessageSource }) {
  const open = useContext(MobileAgentMessageOpenContext)
  const t = useMobileTranslation()
  const { shown, more } = agentMessageSendersShown(from)
  const occurrences = new Map<string, number>()
  return (
    <View style={styles.senders}>
      {shown.length === 0 ? (
        <Text style={styles.name}>
          {t('session.agentMessageAttribution.unnamedSender', 'an agent')}
        </Text>
      ) : null}
      {shown.map((sender) => {
        const identity = JSON.stringify(sender.party)
        const occurrence = occurrences.get(identity) ?? 0
        occurrences.set(identity, occurrence + 1)
        return (
          <SenderName key={`${identity}:${occurrence}`} sender={sender} from={from} open={open} />
        )
      })}
      {more > 0 ? <Text style={styles.meta}>+{more}</Text> : null}
    </View>
  )
}

function SenderName({
  sender,
  from,
  open
}: {
  sender: AgentMessageSource['senders'][number]
  from: AgentMessageSource
  open: React.ContextType<typeof MobileAgentMessageOpenContext>
}) {
  const t = useMobileTranslation()
  const name = useMobileAgentMessageName(
    sender,
    t('session.agentMessageAttribution.unnamedSender', 'an agent')
  )
  const canOpen = agentMessageSenderCanOpen(sender, open !== undefined)
  return (
    <Pressable
      disabled={!canOpen}
      accessibilityRole={canOpen ? 'button' : undefined}
      onPress={() => open?.(from, sender)}
      style={({ pressed }) => [styles.sender, pressed && pressedStyle]}
    >
      <Text style={styles.name}>{name}</Text>
      {canOpen ? <ArrowUpRight size={14} color={colors.textPrimary} /> : null}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel
  },
  content: { flex: 1, minWidth: 0, gap: spacing.xs },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  meta: { color: colors.textMuted, fontSize: typography.metaSize, flexShrink: 1 },
  senders: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  sender: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    flexShrink: 1
  },
  toggle: { color: colors.textMuted, fontSize: typography.metaSize, paddingVertical: spacing.xs },
  body: { position: 'absolute', left: 0, right: 0, top: 0 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  glyph: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    borderRadius: radii.pill,
    backgroundColor: colors.bgPanel
  }
}))
