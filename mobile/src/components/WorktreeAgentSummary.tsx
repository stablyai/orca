import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { agentDotState } from '../worktree/agent-row-display'
import { AgentStateDot } from './AgentStateDot'
import { MobileAgentIcon } from './MobileAgentIcon'
import { t } from '@/i18n/mobile-i18n'

const MAX_VISIBLE_AGENTS = 3

type Props = {
  agents: RuntimeWorktreeAgentRow[]
  expanded: boolean
  now: number
  onToggle: () => void
}

export function WorktreeAgentSummary({ agents, expanded, now, onToggle }: Props) {
  const visibleAgents = agents.slice(0, MAX_VISIBLE_AGENTS)
  const hiddenCount = agents.length - visibleAgents.length
  const subject = t(agents.length === 1 ? 'agents.count.one' : 'agents.count.other', {
    count: agents.length
  })

  return (
    <Pressable
      style={({ pressed }) => [
        styles.summary,
        !expanded && styles.summaryCollapsed,
        pressed && styles.summaryPressed
      ]}
      accessibilityRole="button"
      accessibilityLabel={t(expanded ? 'agents.collapseSummary' : 'agents.expandSummary', {
        agentCountLabel: subject
      })}
      accessibilityState={{ expanded }}
      onPress={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      {expanded ? (
        <Text style={styles.expandedLabel}>{subject}</Text>
      ) : (
        <View style={styles.agentIcons}>
          {visibleAgents.map((agent) => (
            <View key={agent.paneKey} style={styles.agentStatus}>
              <AgentStateDot state={agentDotState(agent, now)} />
              {agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={13} /> : null}
            </View>
          ))}
          {hiddenCount > 0 ? <Text style={styles.hiddenCount}>+{hiddenCount}</Text> : null}
        </View>
      )}
      {expanded ? (
        <ChevronDown size={12} color={colors.textMuted} />
      ) : (
        <ChevronRight size={12} color={colors.textMuted} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  summary: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.button
  },
  summaryCollapsed: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  summaryPressed: {
    opacity: 0.72
  },
  expandedLabel: {
    flex: 1,
    paddingLeft: spacing.xs,
    fontSize: 11,
    fontWeight: '500',
    color: colors.textMuted
  },
  agentIcons: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  agentStatus: {
    height: 19,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 3,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel
  },
  hiddenCount: {
    fontSize: 10,
    color: colors.textMuted
  }
})
