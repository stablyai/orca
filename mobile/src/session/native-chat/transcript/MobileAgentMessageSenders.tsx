import { Fragment, useContext } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import {
  agentMessageSendersShown,
  type AgentMessageSource
} from '../../../../../src/shared/agent-session/agent-session-message-source'
import { agentMessageSenderCanOpen } from '../../../../../src/shared/agent-session/agent-message-presentation'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, pressedStyle } from '../../../theme/mobile-theme'
import { styles } from './mobile-agent-message-card-styles'
import {
  MobileAgentMessageOpenContext,
  useMobileAgentMessageName
} from './mobile-agent-message-context'

// Queued names sit in a caption line, too short for a 44pt target.
const QUEUED_HIT_SLOP = { top: 8, bottom: 8 }

export function MobileAgentMessageSenders({
  from,
  compact = false,
  queued = false
}: {
  from: AgentMessageSource
  compact?: boolean
  queued?: boolean
}) {
  const open = useContext(MobileAgentMessageOpenContext)
  const t = useMobileTranslation()
  const { shown, more } = agentMessageSendersShown(from)
  const occurrences = new Map<string, number>()
  const unnamed = t('session.agentMessageAttribution.unnamedSender', 'an agent')
  return (
    <View
      pointerEvents="box-none"
      style={[styles.senders, compact && styles.compactSenders, queued && styles.queuedSenders]}
    >
      {queued ? (
        <Text style={[styles.meta, styles.queuedLead]}>
          {t('session.agentMessageAttribution.fromSender', 'From')}
        </Text>
      ) : null}
      {shown.length === 0 ? (
        <Text
          pointerEvents={compact ? 'none' : undefined}
          numberOfLines={compact || queued ? 1 : undefined}
          style={queued ? styles.meta : styles.name}
        >
          {unnamed}
        </Text>
      ) : null}
      {shown.map((sender, index) => {
        const identity = JSON.stringify(sender.party)
        const occurrence = occurrences.get(identity) ?? 0
        occurrences.set(identity, occurrence + 1)
        return (
          <Fragment key={`${identity}:${occurrence}`}>
            <SenderName
              sender={sender}
              from={from}
              open={open}
              compact={compact}
              queued={queued}
              shownCount={shown.length}
              unnamed={unnamed}
            />
            {/* Outside the name, so truncating a long name keeps "A…, B". */}
            {queued && index < shown.length - 1 ? (
              <Text style={[styles.meta, styles.queuedComma]}>,</Text>
            ) : null}
          </Fragment>
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
  queued,
  shownCount,
  unnamed
}: {
  compact: boolean
  queued: boolean
  shownCount: number
  unnamed: string
  sender: AgentMessageSource['senders'][number]
  from: AgentMessageSource
  open: React.ContextType<typeof MobileAgentMessageOpenContext>
}) {
  const name = useMobileAgentMessageName(sender, unnamed)
  const canOpen = open !== undefined && agentMessageSenderCanOpen(sender)
  return (
    <Pressable
      disabled={!canOpen}
      accessibilityRole={canOpen ? 'button' : undefined}
      onPress={() => open?.(from, sender)}
      pointerEvents={canOpen ? 'auto' : 'none'}
      hitSlop={queued ? QUEUED_HIT_SLOP : undefined}
      style={({ pressed }) => [
        styles.sender,
        compact && [styles.compactSender, { maxWidth: `${100 / shownCount}%` }],
        queued && styles.queuedSender,
        pressed && pressedStyle
      ]}
    >
      <Text
        numberOfLines={compact || queued ? 1 : undefined}
        style={queued ? [styles.meta, canOpen && styles.queuedOpenableName] : styles.name}
      >
        {name}
      </Text>
      {canOpen && !queued ? (
        <ArrowUpRight
          size={14}
          color={colors.textPrimary}
          style={compact ? styles.compactSenderArrow : undefined}
        />
      ) : null}
    </Pressable>
  )
}
