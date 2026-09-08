import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Square } from 'lucide-react-native'
import type { AgentSessionBackgroundTask } from '../../../src/shared/agent-session-wire'
import { colors, spacing, typography } from '../theme/mobile-theme'

function backgroundTaskLabel(task: AgentSessionBackgroundTask): string {
  if (task.description) {
    return task.description
  }
  switch (task.kind) {
    case 'agent':
      return 'Background agent'
    case 'workflow':
      return 'Background workflow'
    case 'command':
      return 'Background command'
    case 'monitor':
      return 'Background monitor'
    default:
      return 'Background task'
  }
}

export type MobileNativeChatBackgroundTasksProps = {
  tasks: readonly AgentSessionBackgroundTask[]
  supportsTaskStop: boolean
  onStop: (taskId?: string) => void
}

/**
 * Work the agent left running after its turn ended. Without this row the only
 * signal is the absence of one — the turn reads as finished while a detached
 * process keeps going.
 *
 * Self-gating so the caller renders it unconditionally: nothing running, no row.
 */
export function MobileNativeChatBackgroundTasks(
  props: Partial<MobileNativeChatBackgroundTasksProps>
): React.JSX.Element | null {
  const tasks = props.tasks ?? []
  const count = tasks.length
  const onStop = props.onStop
  if (count === 0 || !onStop) {
    return null
  }
  return (
    <View style={styles.root} accessibilityLabel="Background terminals still running">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {count === 1 ? '1 background terminal' : `${count} background terminals`}
        </Text>
        {props.supportsTaskStop && count > 1 ? (
          <Pressable
            style={({ pressed }) => [styles.stopAll, pressed && styles.pressed]}
            onPress={() => onStop()}
            hitSlop={8}
            accessibilityLabel="Stop all background terminals"
          >
            <Text style={styles.stopLabel}>Stop all</Text>
          </Pressable>
        ) : null}
      </View>
      {tasks.map((task) => (
        <View key={task.id} style={styles.row}>
          <Text style={styles.taskLabel} numberOfLines={1}>
            {backgroundTaskLabel(task)}
          </Text>
          {props.supportsTaskStop ? (
            <Pressable
              style={({ pressed }) => [styles.stopTask, pressed && styles.pressed]}
              onPress={() => onStop(task.id)}
              hitSlop={8}
              accessibilityLabel={`Stop ${backgroundTaskLabel(task)}`}
            >
              <Square
                size={11}
                color={colors.statusRed}
                strokeWidth={2.4}
                fill={colors.statusRed}
              />
              <Text style={styles.stopLabel}>Stop</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
    gap: 2
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  title: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '700',
    flexShrink: 1
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  taskLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    flexShrink: 1
  },
  stopAll: {
    paddingVertical: 2,
    paddingHorizontal: spacing.xs
  },
  stopTask: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 2,
    paddingHorizontal: spacing.xs
  },
  stopLabel: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  pressed: {
    opacity: 0.6
  }
})
