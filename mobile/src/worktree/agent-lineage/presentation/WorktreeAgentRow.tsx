import { agentNoUpdateLabel } from '../../../../../src/shared/agent-status/presentation/agent-row-decay-state'
import { MobileForkMarkedName } from '../../../session/fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../../../session/fork/mobile-fork-marked-name'
import { memo, type ReactNode } from 'react'
import { Bell } from 'lucide-react-native'
import { listedAgentVerdict } from '../../../agents/agent-list-rows'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { Pressable, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { withoutNativeChatVisualDirectiveLines } from '../../../../../src/shared/native-chat/visuals/native-chat-visual-directive'
import { colors, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { formatAgentTypeLabel } from '../../../../../src/shared/agent-status/presentation/agent-type-label'
import {
  agentDisplayForkedLead,
  agentDisplayLabel,
  agentDotState,
  agentRowTimeAt,
  agentStateLabel,
  agentStatePhrase,
  formatTimeAgo
} from '../agent-row-display'
import { AgentStateDot, agentStateTextColor } from '../../../agents/presentation/AgentStateDot'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import type { AgentChildRowModel } from '../../../../../src/shared/agent-status/presentation/agent-child-row-model'
import { mobileAgentChildRowText } from '../mobile-agent-child-row-text'

export const AGENT_ROW_INDENT_PER_DEPTH = 14
// Grow the 30 pt line, and the 18 pt detail line a phrase sits on, to 44 pt targets.
const AGENT_ROW_HIT_SLOP = { top: 7, bottom: 7 } as const
const PHRASE_HIT_SLOP = { top: 13, bottom: 13 } as const

/** `message`: state dot, then what it last said (the Full list layout and child rows). `state`: its
 *  name and a coloured state word. `phrase`: a lone agent's sentence, as its workspace's detail line. */
export type WorktreeAgentRowVariant = 'message' | 'state' | 'phrase'

type Props = {
  agent: RuntimeWorktreeAgentRow
  depth: number
  now: number
  // Use workspace’s unvisited signal for agent bold/foreground too, matching desktop.
  unvisited: boolean
  childRow?: AgentChildRowModel
  isReadOnly?: boolean
  onPress?: (paneKey: string) => void
  onLongPress?: () => void
  trailing?: ReactNode
  variant?: WorktreeAgentRowVariant
  /** Follows a phrase after a dot, e.g. "2 terminals". */
  suffix?: string
}

// Match compact desktop DashboardAgentRow: state→identity→message/prompt→age.
function WorktreeAgentRowComponent({
  agent,
  depth,
  now,
  unvisited,
  childRow,
  isReadOnly,
  onPress,
  onLongPress,
  trailing,
  variant = 'message',
  suffix
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const dotState = childRow?.displayState ?? agentDotState(agent, now)
  // Visuals render only in transcript; row keeps surrounding prose and treats visual-only reply as empty.
  const reply = agent.lastAssistantMessage
  const label = agentDisplayLabel(
    reply
      ? { ...agent, lastAssistantMessage: withoutNativeChatVisualDirectiveLines(reply) }
      : agent,
    now
  )
  const forkedLead = agentDisplayForkedLead(agent, label)
  const childText = childRow ? mobileAgentChildRowText(childRow, now) : null
  const timeAt = childRow ? childRow.firstObservedAt : agentRowTimeAt(agent)
  // Like desktop, a silent row reports how long since its last update, not when its turn began.
  const ts =
    childRow && timeAt <= 0
      ? ''
      : !childRow && dotState === 'unverifiable'
        ? agentNoUpdateLabel(agent, now)
        : formatTimeAgo(timeAt, now)

  const unread =
    !childRow && listedAgentVerdict(agent)?.unread ? (
      <Bell
        size={12}
        color={colors.statusAmber}
        fill={colors.statusAmber}
        accessibilityLabel={t('agents.list.unread', 'Unread')}
      />
    ) : null
  const logo =
    !childRow && agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={13} /> : null
  const name = formatAgentTypeLabel(agent.agentType)
  const phrase = variant === 'phrase' ? agentStatePhrase(name, dotState) : null

  const content =
    variant === 'message' || childRow ? (
      <View style={[styles.row, { paddingLeft: depth * AGENT_ROW_INDENT_PER_DEPTH }]}>
        <AgentStateDot state={dotState} />
        {/* Use desktop-style agent identity logo instead of two-letter code. */}
        {logo}
        <Text
          style={[styles.label, unvisited && styles.labelUnvisited]}
          numberOfLines={1}
          accessibilityLabel={
            !childText && forkedLead
              ? `${mobileForkAccessibleName(forkedLead.name)}${forkedLead.rest}`
              : undefined
          }
        >
          {childText ? (
            <>
              {childText.lead}
              {childText.trail ? ` · ${childText.trail}` : ''}
            </>
          ) : forkedLead ? (
            <>
              <MobileForkMarkedName name={forkedLead.name} />
              {forkedLead.rest}
            </>
          ) : (
            label
          )}
        </Text>
        {unread}
        {trailing}
        <Text style={styles.time}>{ts}</Text>
      </View>
    ) : phrase ? (
      <View style={styles.phraseRow}>
        {logo}
        <Text style={styles.phrase} numberOfLines={1}>
          {suffix ? `${phrase} · ${suffix}` : phrase}
        </Text>
        {unread}
        {trailing}
      </View>
    ) : (
      <View style={[styles.row, { paddingLeft: depth * AGENT_ROW_INDENT_PER_DEPTH }]}>
        {logo}
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text
          style={[styles.stateWord, { color: agentStateTextColor(dotState) }]}
          numberOfLines={1}
        >
          {agentStateLabel(dotState)}
        </Text>
        {unread}
        <View style={styles.spacer} />
        {trailing}
        <Text style={styles.time}>{ts}</Text>
      </View>
    )
  return onPress ? (
    <Pressable
      style={({ pressed }) => pressed && pressedStyle}
      hitSlop={phrase ? PHRASE_HIT_SLOP : AGENT_ROW_HIT_SLOP}
      disabled={isReadOnly}
      accessibilityRole="button"
      onPress={(event) => {
        event.stopPropagation()
        onPress(agent.paneKey)
      }}
      onLongPress={onLongPress}
      delayLongPress={400}
    >
      {content}
    </Pressable>
  ) : (
    content
  )
}

export const WorktreeAgentRow = memo(WorktreeAgentRowComponent)

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 30
  },
  label: {
    flex: 1,
    fontSize: 14,
    color: colors.textMuted
  },
  labelUnvisited: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  phraseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 18,
    marginTop: 2
  },
  phrase: {
    flexShrink: 1,
    fontSize: 14,
    color: colors.textMuted
  },
  name: {
    flexShrink: 1,
    fontSize: 14,
    color: colors.textPrimary
  },
  stateWord: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '500'
  },
  spacer: {
    flex: 1
  },
  time: {
    fontSize: 13,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
}))
