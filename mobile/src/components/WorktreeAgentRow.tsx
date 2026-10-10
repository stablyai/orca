import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat-visual-directive'
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
  // Bold/foreground until the user has visited the worktree, mirroring desktop's
  // unvisited rule (the workspace title and its agent rows share one signal).
  unvisited: boolean
  childRow?: AgentChildRowModel
  elapsedNow?: number
  isReadOnly?: boolean
  onPress?: (paneKey: string) => void
}

// One inline agent row: state dot → identity → last message/prompt → time ago.
// Mirrors desktop DashboardAgentRow's compact in-card layout.
function WorktreeAgentRowComponent({
  agent,
  depth,
  now,
  unvisited,
  childRow,
  elapsedNow,
  isReadOnly,
  onPress
}: Props) {
  const dotState = childRow?.displayState ?? agentDotState(agent, now)
  // A visual line renders only in the transcript; the row shows the words around it, and a reply
  // that is only a visual falls back like an empty one.
  const reply = agent.lastAssistantMessage
  const label = agentDisplayLabel(
    reply
      ? { ...agent, lastAssistantMessage: withoutNativeChatVisualDirectiveLines(reply) }
      : agent,
    now
  )
  const childText = childRow ? mobileAgentChildRowText(childRow, now) : null
  const ts = childRow
    ? elapsedNow !== undefined && childRow.firstObservedAt > 0
      ? formatTimeAgo(childRow.firstObservedAt, elapsedNow)
      : ''
    : formatTimeAgo(agentRowTimeAt(agent), now)

  const content = (
    <View style={[styles.row, { paddingLeft: depth * INDENT_PER_DEPTH }]}>
      <AgentStateDot state={dotState} />
      {/* Agent identity logo (Claude/Codex/…), matching the desktop sidebar's
          agent icons instead of a two-letter text code. */}
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
