import { Fragment, useContext } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import {
  agentMessageSendersShown,
  type AgentMessageSource
} from '../../../../../../src/shared/agent-session/journal/agent-session-message-source'
import { agentMessageSenderCanOpen } from '../../../../../../src/shared/agent-session/view/messages/agent-message-presentation'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle } from '../../../../theme/mobile-theme'
import { styles } from './mobile-agent-message-card-styles'
import {
  MobileAgentMessageOpenContext,
  useMobileAgentMessageName
} from './mobile-agent-message-context'

// Queued names sit in a caption line, too short for a 44pt target.
const QUEUED_HIT_SLOP = { top: 8, bottom: 8 }

export function MobileAgentMessageSenders({
  from,
  queued = false,
  bare = false
}: {
  from: AgentMessageSource
  queued?: boolean
  /** Names only, without the queued line's "From": the row draws its own lead. */
  bare?: boolean
}) {
  const open = useContext(MobileAgentMessageOpenContext)
  const t = useMobileTranslation()
  const { shown, more } = agentMessageSendersShown(from)
  const occurrences = new Map<string, number>()
  const unnamed = t('session.agentMessageAttribution.unnamedSender', 'an agent')
  return (
    <View pointerEvents="box-none" style={[styles.senders, queued && styles.queuedSenders]}>
      {queued && !bare ? (
        <Text style={[styles.meta, styles.queuedLead]}>
          {t('session.agentMessageAttribution.fromSender', 'From')}
        </Text>
      ) : null}
      {shown.length === 0 ? (
        <Text
          numberOfLines={queued ? 1 : undefined}
          style={queued ? [styles.meta, styles.queuedMeta] : styles.name}
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
            <SenderName sender={sender} from={from} open={open} queued={queued} unnamed={unnamed} />
            {/* Outside the name, so truncating a long name keeps "A…, B". */}
            {queued && index < shown.length - 1 ? (
              <Text style={[styles.meta, styles.queuedMeta, styles.queuedComma]}>,</Text>
            ) : null}
          </Fragment>
        )
      })}
      {more > 0 ? <Text style={[styles.meta, queued && styles.queuedMeta]}>+{more}</Text> : null}
    </View>
  )
}

function SenderName({
  sender,
  from,
  open,
  queued,
  unnamed
}: {
  queued: boolean
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
        queued && styles.queuedSender,
        pressed && pressedStyle
      ]}
    >
      <Text
        numberOfLines={queued ? 1 : undefined}
        style={
          queued
            ? [styles.meta, styles.queuedMeta, canOpen && styles.queuedOpenableName]
            : styles.name
        }
      >
        {name}
      </Text>
      {canOpen && !queued ? <ArrowUpRight size={14} color={colors.textPrimary} /> : null}
    </Pressable>
  )
}
