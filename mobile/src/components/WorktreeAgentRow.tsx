import { agentNoUpdateLabel } from '../../../src/shared/agent-status/presentation/agent-row-decay-state'
import { memo, useEffect, useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import {
  reconcileWorktreeAgentRowWithSessionDone,
  resolveHostAgentRowDotState,
  subscribeTabCompletionState
} from '../session/catalog-worktree-unread-status'
import { colors, spacing, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { agentDisplayLabel, agentRowTimeAt, formatTimeAgo } from '../worktree/agent-row-display'
import { AgentStateDot } from './AgentStateDot'
import { MobileAgentIcon } from './MobileAgentIcon'
import type { AgentChildRowModel } from '../../../src/shared/agent-status/presentation/agent-child-row-model'
import { mobileAgentChildRowText } from '../session/mobile-agent-child-row-text'

export const AGENT_ROW_INDENT_PER_DEPTH = 14

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
  trailing
}: Props) {
  useMobileColorScheme()
  const [, setCompletionRev] = useState(0)
  useEffect(() => subscribeTabCompletionState(() => setCompletionRev((rev) => rev + 1)), [])
  const effectiveAgent = reconcileWorktreeAgentRowWithSessionDone(agent)
  const dotState = childRow?.displayState ?? resolveHostAgentRowDotState(effectiveAgent, now)
  // Visuals render only in transcript; row keeps surrounding prose and treats visual-only reply as empty.
  const reply = effectiveAgent.lastAssistantMessage
  const label = agentDisplayLabel(
    reply
      ? { ...effectiveAgent, lastAssistantMessage: withoutNativeChatVisualDirectiveLines(reply) }
      : effectiveAgent,
    now
  )
  const childText = childRow ? mobileAgentChildRowText(childRow, now) : null
  const timeAt = childRow ? childRow.firstObservedAt : agentRowTimeAt(effectiveAgent)
  // Like desktop, a silent row reports how long since its last update, not when its turn began.
  const ts =
    childRow && timeAt <= 0
      ? ''
      : !childRow && dotState === 'unverifiable'
        ? agentNoUpdateLabel(effectiveAgent, now)
        : formatTimeAgo(timeAt, now)

  const content = (
    <View style={[styles.row, { paddingLeft: depth * AGENT_ROW_INDENT_PER_DEPTH }]}>
      <AgentStateDot state={dotState} />
      {/* Use desktop-style agent identity logo instead of two-letter code. */}
      {!childRow && effectiveAgent.agentType ? (
        <MobileAgentIcon agentId={effectiveAgent.agentType} size={13} />
      ) : null}
      <Text
        style={[styles.label, (unvisited || dotState === 'unread') && styles.labelUnvisited]}
        numberOfLines={1}
      >
        {childText ? (
          <>
            {childText.lead}
            {childText.trail ? ` · ${childText.trail}` : ''}
          </>
        ) : (
          label
        )}
      </Text>
      {trailing}
      <Text style={styles.time}>{ts}</Text>
    </View>
  )
  return onPress ? (
    <Pressable
      style={({ pressed }) => pressed && pressedStyle}
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
}))
