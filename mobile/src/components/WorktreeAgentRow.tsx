import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { colors, spacing } from '../theme/mobile-theme'
import { agentDisplayLabel, agentDotState, formatTimeAgo } from '../worktree/agent-row-display'
import { AgentStateDot } from './AgentStateDot'
import { MobileAgentIcon } from './MobileAgentIcon'

const INDENT_PER_DEPTH = 14

type Props = {
  agent: RuntimeWorktreeAgentRow
  depth: number
  now: number
  // Bold/foreground until the user has visited the worktree, mirroring desktop's
  // unvisited rule (the workspace title and its agent rows share one signal).
  unvisited: boolean
}

// One inline agent row: state dot → identity → last message/prompt → time ago.
// Mirrors desktop DashboardAgentRow's compact in-card layout.
function WorktreeAgentRowComponent({ agent, depth, now, unvisited }: Props) {
  const dotState = agentDotState(agent, now)
  const label = agentDisplayLabel(agent, now)
  const ts = formatTimeAgo(agent.stateStartedAt, now)

  return (
    <View style={[styles.row, { paddingLeft: depth * INDENT_PER_DEPTH }]}>
      <AgentStateDot state={dotState} />
      {/* Agent identity logo (Claude/Codex/…), matching the desktop sidebar's
          agent icons instead of a two-letter text code. */}
      {agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={13} /> : null}
      <Text style={[styles.label, unvisited && styles.labelUnvisited]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.time}>{ts}</Text>
    </View>
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
