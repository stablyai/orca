import { agentNoUpdateLabel } from '../../../src/shared/agent-row-decay-state'
import { memo, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { colors, spacing, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
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

export const AGENT_ROW_INDENT_PER_DEPTH = 14

type Props = {
  agent: RuntimeWorktreeAgentRow
  depth: number
  now: number
  // Use workspace’s unvisited signal for agent bold/foreground too, matching desktop.
  unvisited: boolean
  childRow?: AgentChildRowModel
  isReadOnly?: boolean
  selectable?: boolean
  /** This session is the one open from the sidebar. Child lines share the parent pane and stay unfilled. */
  selected?: boolean
  onPress?: (paneKey: string) => void
  onPressIn?: () => void
  onPressOut?: () => void
  onLongPress?: (paneKey: string) => void
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
  selectable = false,
  selected = false,
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  trailing
}: Props) {
  useMobileColorScheme()
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
    <View
      style={[
        styles.row,
        selectable && styles.rowSelectable,
        { paddingLeft: depth * AGENT_ROW_INDENT_PER_DEPTH }
      ]}
    >
      <AgentStateDot state={dotState} />
      {/* Use desktop-style agent identity logo instead of two-letter code. */}
      {!childRow && agent.agentType ? (
        <MobileAgentIcon agentId={agent.agentType} size={13} />
      ) : null}
      <Text
        style={[
          styles.label,
          selectable && styles.labelSelectable,
          unvisited && styles.labelUnvisited
        ]}
        numberOfLines={selectable ? 2 : 1}
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
  if (!onPress && !onLongPress && !childRow) {
    return content
  }
  return (
    <Pressable
      disabled={isReadOnly || (!onPress && !onLongPress)}
      accessibilityRole="button"
      accessibilityState={selected ? { selected: true } : undefined}
      delayLongPress={400}
      style={({ pressed }) => [
        pressed && pressedStyle,
        selectable && (selected || pressed) && styles.rowHighlight,
        selectable && selected && styles.rowSelected,
        selectable && pressed && styles.rowPressed
      ]}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onPress={
        onPress
          ? (event) => {
              event.stopPropagation()
              onPress(agent.paneKey)
            }
          : undefined
      }
      onLongPress={
        onLongPress
          ? (event) => {
              event.stopPropagation()
              onLongPress(agent.paneKey)
            }
          : undefined
      }
    >
      {content}
    </Pressable>
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
  // 44pt is the smallest row a finger can hit without opening the workspace behind it.
  rowSelectable: {
    minHeight: 44,
    marginTop: spacing.xs,
    paddingVertical: spacing.sm
  },
  // Pad the fill, not the text: the negative margin puts that padding back, so idle rows stay aligned.
  // Radius is desktop `rounded-sm` (`--radius-sm` = 0.6 × `--radius`).
  rowHighlight: {
    marginHorizontal: -spacing.sm,
    marginVertical: -spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 6
  },
  rowSelected: {
    backgroundColor: colors.bgPanel
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  label: {
    flex: 1,
    fontSize: 11,
    color: colors.textMuted
  },
  labelSelectable: {
    fontSize: 14
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
