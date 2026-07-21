import { Pressable, StyleSheet, Text, View } from 'react-native'
import { AgentStateDot } from '../components/AgentStateDot'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { formatTimeAgo } from '../worktree/agent-row-display'
import type { MobileAgentThread } from './mobile-agent-list'

const INDENT_PER_DEPTH = 14

export function MobileAgentThreadRow({
  thread,
  now,
  onPress
}: {
  thread: MobileAgentThread
  now: number
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable style={styles.row} onPress={onPress} accessibilityRole="button">
      <AgentStateDot state={thread.dotState} />
      {thread.agent.agentType ? (
        <MobileAgentIcon agentId={thread.agent.agentType} size={16} />
      ) : null}
      <View style={[styles.main, { paddingLeft: thread.lineageDepth * INDENT_PER_DEPTH }]}>
        <Text style={styles.title} numberOfLines={2}>
          {thread.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {thread.subtitle}
        </Text>
        {thread.toolSummary ? (
          <Text style={styles.toolSummary} numberOfLines={1}>
            {thread.toolSummary}
          </Text>
        ) : null}
      </View>
      <Text style={styles.time}>{formatTimeAgo(thread.sortTimestamp, now)}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  main: {
    flex: 1,
    gap: 3
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600',
    lineHeight: 19
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  toolSummary: {
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: 11
  },
  time: {
    color: colors.textMuted,
    fontSize: 11,
    minWidth: 48,
    textAlign: 'right'
  }
})
