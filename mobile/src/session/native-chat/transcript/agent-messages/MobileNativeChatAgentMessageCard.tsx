import { memo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Bot, ChevronDown, ChevronUp } from 'lucide-react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../../src/shared/agent-session/agent-session-message-source'
import { agentMessageSendersShown } from '../../../../../../src/shared/agent-session/agent-session-message-source'
import {
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageCanCopy,
  type AgentMessageHeading
} from '../../../../../../src/shared/agent-session/agent-message-presentation'
import { mobileNativeChatDisplayCopyText } from '../messages/mobile-native-chat-display-copy'
import { MobileNativeChatMarkdown } from '../message-content/MobileNativeChatMarkdown'
import { MobileAgentIcon } from '../../../../components/MobileAgentIcon'
import { AgentStateDot } from '../../../../components/AgentStateDot'
import { MobileSourceCopyButton } from '../../../../components/MobileSourceCopyButton'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors } from '../../../../theme/mobile-theme'
import { styles } from './mobile-agent-message-card-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileAgentMessageView } from './mobile-agent-message-context'
import { MobileAgentMessageSenders } from './MobileAgentMessageSenders'
import { MobileNativeChatMessageTime } from '../messages/MobileNativeChatMessageTime'
import { useMobileNativeChatDisclosure } from '../viewport/mobile-native-chat-disclosure-store'
import { CHAT_PROSE_SCALE } from '../messages/mobile-native-chat-message-styles'

type AgentMessageCardProps = {
  message: NativeChatMessage
  from: AgentMessageSource
  fontScale: number
  attachments: React.ReactNode
  onLongPress?: () => void
  status?: React.ReactNode
}

export const MobileNativeChatAgentMessageCard = memo(function MobileNativeChatAgentMessageCard({
  message,
  from,
  fontScale,
  attachments,
  onLongPress,
  status
}: AgentMessageCardProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const text = mobileNativeChatDisplayCopyText(message)
  const [open, setOpen] = useMobileNativeChatDisclosure(`agent-message:${message.id}`, false)
  const headings: Record<AgentMessageHeading, string> = {
    started: t('chat.agentMessage.startedWorker', 'Started worker'),
    'reopened-worker': t('chat.agentMessage.reopenedWorker', 'Reopened worker'),
    'followed-up-worker': t('chat.agentMessage.sentFollowUpToWorker', 'Sent follow-up to worker'),
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
          <SenderAvatar sender={agentMessagePrimarySender(from)} />
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
        <MobileAgentMessageSenders compact from={from} />
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
          <MobileNativeChatMarkdown
            content={text}
            rangeSelectable
            textScale={CHAT_PROSE_SCALE * fontScale}
            onLongPress={onLongPress}
          />
          {status}
          <MobileNativeChatMessageTime timestamp={message.timestamp} fontScale={fontScale} />
        </View>
      ) : null}
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
