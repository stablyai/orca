import { ChevronDown } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'
import { agentDotState } from '../worktree/agent-row-display'
import { AgentStateDot } from './AgentStateDot'
import { MobileAgentIcon } from './MobileAgentIcon'
import { pressTransition, slideTransition } from './ui/transition-styles'

const MAX_VISIBLE_AGENTS = 3

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  expanded: boolean
  now: number
  onToggle: () => void
}

/** "3 agents" with their states, a 44 pt disclosure inside the row that shows every agent. */
export function WorktreeAgentSummary({ agents, expanded, now, onToggle }: Props) {
  const visibleAgents = agents.slice(0, MAX_VISIBLE_AGENTS)
  const hiddenCount = agents.length - visibleAgents.length
  const subject = `${agents.length} agents`

  return (
    <Pressable
      style={({ pressed }) => [
        styles.summary,
        pressed && styles.summaryPressed,
        pressed ? pressTransition.pressed : pressTransition.rest
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${subject}`}
      accessibilityState={{ expanded }}
      onPress={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      {expanded ? null : (
        <View style={styles.agentIcons}>
          {visibleAgents.map((agent) => (
            <View key={agent.paneKey} style={styles.agentStatus}>
              <AgentStateDot state={agentDotState(agent, now)} size="regular" />
              {agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={14} /> : null}
            </View>
          ))}
          {hiddenCount > 0 ? <Text style={styles.hiddenCount}>+{hiddenCount}</Text> : null}
        </View>
      )}
      <Text style={styles.label}>{subject}</Text>
      <View
        style={[expanded ? styles.chevronOpen : styles.chevronClosed, slideTransition]}
        pointerEvents="none"
      >
        <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  summary: {
    alignSelf: 'flex-start',
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.field
  },
  summaryPressed: { backgroundColor: colors.fill },
  agentIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  agentStatus: {
    height: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.fill
  },
  hiddenCount: {
    ...textStyles.footnote,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  label: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textSecondary
  },
  chevronOpen: { transform: [{ rotate: '0deg' }] },
  chevronClosed: { transform: [{ rotate: '-90deg' }] }
})
