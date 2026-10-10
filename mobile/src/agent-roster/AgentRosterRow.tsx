import { memo } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { WorktreeAgentRow } from '../components/WorktreeAgentRow'
import { colors, spacing } from '../theme/mobile-theme'
import type { AgentRosterEntry } from './agent-roster-entries'

type Props = {
  entry: AgentRosterEntry
  now: number
  onPress: (entry: AgentRosterEntry) => void
}

// One flat roster row: the agent line the sidebar renders, plus the workspace it belongs to — the
// pair a workspace-grouped list makes the user hunt for.
function AgentRosterRowComponent({ entry, now, onPress }: Props) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress(entry)}
      accessibilityRole="button"
      accessibilityLabel={`Open agent in ${entry.worktreeLabel}`}
    >
      <WorktreeAgentRow agent={entry.agent} depth={0} now={now} unvisited={entry.unvisited} />
      <Text style={styles.worktreeLabel} numberOfLines={1}>
        {entry.worktreeLabel}
      </Text>
    </Pressable>
  )
}

export const AgentRosterRow = memo(AgentRosterRowComponent)

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  // No left indent: AgentStateDot is the row's first child, so this caption starts under the dot.
  worktreeLabel: {
    marginTop: 2,
    fontSize: 10,
    color: colors.textMuted
  }
})
