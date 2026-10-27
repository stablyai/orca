import { agentNoUpdateLabel } from '../../../src/shared/agent-row-decay-state'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { colors, spacing } from '../theme/mobile-theme'
import {
  agentDisplayLabel,
  agentDotState,
  agentRowTimeAt,
  formatTimeAgo
} from '../worktree/agent-row-display'
import { AgentStateDot } from './AgentStateDot'
import { MobileAgentIcon } from './MobileAgentIcon'
import type { AgentChildRowModel } from '../../../src/shared/agent-child-row-model'
import { mobileAgentChildRowText } from '../session/mobile-agent-child-row-text'

const INDENT_PER_DEPTH = 14

type Props = {
  agent: RuntimeWorktreeAgentRow
  depth: number
  now: number
  // Use workspace’s unvisited signal for agent bold/foreground too, matching desktop.
  unvisited: boolean
  childRow?: AgentChildRowModel
  isReadOnly?: boolean
  onPress?: (paneKey: string) => void
}

// Match compact desktop DashboardAgentRow: state→identity→message/prompt→age.
function WorktreeAgentRowComponent({
  agent,
  depth,
  now,
  unvisited,
  childRow,
  isReadOnly,
  onPress
}: Props) {
  const dotState = childRow?.displayState ?? agentDotState(agent, now)
  // Visuals render only in transcript; row keeps surrounding prose and treats visual-only reply as empty.
  const reply = agent.lastAssistantMessage
  const label = agentDisplayLabel(
    reply
      ? { ...agent, lastAssistantMessage: withoutNativeChatVisualDirectiveLines(reply) }
      : agent,
    now
  )
  const childText = childRow ? mobileAgentChildRowText(childRow, now) : null
  const timeAt = childRow ? childRow.firstObservedAt : agentRowTimeAt(agent)
  // Like desktop, a silent row reports how long since its last update, not when its turn began.
  const ts =
    childRow && timeAt <= 0
      ? ''
      : !childRow && dotState === 'unverifiable'
        ? agentNoUpdateLabel(agent, now)
        : formatTimeAgo(timeAt, now)

  const content = (
    <View style={[styles.row, { paddingLeft: depth * INDENT_PER_DEPTH }]}>
      <AgentStateDot state={dotState} />
      {/* Use desktop-style agent identity logo instead of two-letter code. */}
      {!childRow && agent.agentType ? (
        <MobileAgentIcon agentId={agent.agentType} size={13} />
      ) : null}
      <Text style={[styles.label, unvisited && styles.labelUnvisited]} numberOfLines={1}>
        {childText ? (
          <>
            {childText.lead}
            {childText.trail ? ` · ${childText.trail}` : ''}
          </>
        ) : (
          label
        )}
      </Text>
      <Text style={styles.time}>{ts}</Text>
    </View>
  )
  return childRow ? (
    <Pressable
      disabled={isReadOnly || !onPress}
      accessibilityRole="button"
      onPress={(event) => {
        event.stopPropagation()
        onPress?.(agent.paneKey)
      }}
    >
      {content}
    </Pressable>
  ) : (
    content
  )
}

export const WorktreeAgentRow = memo(WorktreeAgentRowComponent)

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 3
  },
  label: {
    flex: 1,
    fontSize: 11,
    color: colors.textMuted
  },
  labelUnvisited: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  time: {
    fontSize: 10,
    color: colors.textMuted
  }
})
