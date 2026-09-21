import { ChevronRight, ListTodo } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { TaskProviderLogo } from '../components/TaskProviderLogo'
import type { TaskProvider } from '../tasks/mobile-task-providers'
import { colors, radii, spacing } from '../theme/mobile-theme'

const TASK_PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear'
}

export function MobileHomeTasksCard(props: {
  enabled: boolean
  providers: TaskProvider[]
  onOpen: (provider?: TaskProvider) => void
}) {
  return (
    <Pressable
      disabled={!props.enabled}
      style={({ pressed }) => [
        styles.card,
        !props.enabled && styles.cardDisabled,
        pressed && styles.cardPressed
      ]}
      onPress={() => props.onOpen()}
    >
      <View style={styles.icon}>
        <ListTodo size={18} color={colors.textSecondary} />
      </View>
      <View style={styles.main}>
        <Text style={styles.title}>Tasks</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {props.providers.length > 0
            ? props.providers.map((provider) => TASK_PROVIDER_LABELS[provider]).join(' · ')
            : 'No task sources connected'}
        </Text>
      </View>
      <View style={styles.trailing}>
        <View
          style={styles.providerRow}
          accessibilityLabel={props.providers
            .map((provider) => TASK_PROVIDER_LABELS[provider])
            .join(', ')}
        >
          {props.providers.map((provider) => (
            <Pressable
              key={provider}
              accessibilityRole="button"
              accessibilityLabel={`Open ${TASK_PROVIDER_LABELS[provider]} tasks`}
              hitSlop={8}
              style={({ pressed }) => [
                styles.providerButton,
                pressed && styles.providerButtonPressed
              ]}
              onPress={(event) => {
                event.stopPropagation()
                props.onOpen(provider)
              }}
            >
              <TaskProviderLogo provider={provider} size={22} color={colors.textSecondary} />
            </Pressable>
          ))}
        </View>
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    minHeight: 72,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: 12
  },
  cardDisabled: { opacity: 0.45 },
  cardPressed: { backgroundColor: colors.bgRaised },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14
  },
  main: { flex: 1, minWidth: 0 },
  title: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  subtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 3 },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: spacing.sm
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2
  },
  providerButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  providerButtonPressed: { backgroundColor: colors.bgRaised }
})
