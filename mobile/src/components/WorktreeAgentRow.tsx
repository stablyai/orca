import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat-visual-directive'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'
import { pressTransition } from './ui/transition-styles'
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

const INDENT_PER_DEPTH = 16

type Props = {
  agent: RuntimeWorktreeAgentRow
  depth: number
  now: number
  // Bold/foreground until the user has visited the worktree, mirroring desktop's
  // unvisited rule (the workspace title and its agent rows share one signal).
  unvisited: boolean
  childRow?: AgentChildRowModel
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
  isReadOnly,
  onPress
}: Props) {
  const dotState = childRow?.displayState ?? agentDotState(agent, now)
  // A visual line renders only in the transcript; the row shows the words around it, and a reply
  // that is only a visual falls back like an empty one.
  const reply = agent.lastAssistantMessage
  const label = agentDisplayLabel(
    reply
      ? {
          ...agent,
          lastAssistantMessage: withoutNativeChatVisualDirectiveLines(reply)
        }
      : agent,
    now
  )
  const childText = childRow ? mobileAgentChildRowText(childRow, now) : null
  const timeAt = childRow ? childRow.firstObservedAt : agentRowTimeAt(agent)
  const ts = childRow && timeAt <= 0 ? '' : formatTimeAgo(timeAt, now)

  const needsYou = dotState === 'blocked' || dotState === 'waiting'
  const content = (
    <View style={[styles.row, childRow && styles.rowPressable]}>
      <AgentStateDot state={dotState} size="regular" />
      {/* Agent identity logo (Claude/Codex/…), matching the desktop sidebar's
          agent icons instead of a two-letter text code. */}
      {!childRow && agent.agentType ? (
        <MobileAgentIcon agentId={agent.agentType} size={14} />
      ) : null}
      <Text
        style={[styles.label, unvisited && styles.labelUnvisited, needsYou && styles.labelNeedsYou]}
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
      {ts ? <Text style={styles.time}>{ts}</Text> : null}
    </View>
  )
  const indent = { paddingLeft: depth * INDENT_PER_DEPTH }
  return childRow ? (
    <View style={indent}>
      <Pressable
        disabled={isReadOnly || !onPress}
        accessibilityRole="button"
        accessibilityLabel={childText ? childText.lead : label}
        onPress={(event) => {
          event.stopPropagation()
          onPress?.(agent.paneKey)
        }}
        style={({ pressed }) => [
          styles.pressable,
          pressed && styles.pressed,
          pressed ? pressTransition.pressed : pressTransition.rest
        ]}
      >
        {content}
      </Pressable>
    </View>
  ) : (
    <View style={indent}>{content}</View>
  )
}

export const WorktreeAgentRow = memo(WorktreeAgentRowComponent)

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 20
  },
  // A child row opens its pane, so it gets a full touch box and a pressed fill.
  rowPressable: { minHeight: MIN_TOUCH_TARGET },
  pressable: {
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.field
  },
  pressed: { backgroundColor: colors.fill },
  label: {
    ...textStyles.subhead,
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary
  },
  labelUnvisited: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  labelNeedsYou: { color: colors.statusAmber },
  time: {
    ...textStyles.footnote,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
