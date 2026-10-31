import type { MobileNativeChatThreadGoal } from './use-mobile-native-chat-session'
import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { ChevronDown, ChevronUp, Goal, Pause, Play, Trash2 } from 'lucide-react-native'
import {
  agentSessionThreadGoalElapsedSeconds,
  agentSessionThreadGoalStatusChange
} from '../../../src/shared/agent-session-thread-goal'
import type { MobileThreadGoalControls } from './use-mobile-structured-thread-goal-controls'
import {
  NATIVE_CHAT_THREAD_GOAL_COPY as copy,
  nativeChatThreadGoalStatusKey
} from '../../../src/shared/native-chat-thread-goal-copy'
import { formatNativeChatDuration } from '../../../src/shared/native-chat-turn-status'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MobileNativeChatThreadGoalBanner({
  goal,
  runningTurn,
  hostClockOffsetMs,
  controls
}: MobileNativeChatThreadGoal): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const now = useNow(1_000, goal.status === 'active' && runningTurn !== null)
  const key = nativeChatThreadGoalStatusKey(goal.status, runningTurn !== null)
  if (key === null) {
    return null
  }
  const label = {
    pursuing: t('components.native-chat.goal.pursuing', copy.pursuing),
    set: t('components.native-chat.goal.set', copy.set),
    paused: t('components.native-chat.goal.paused', copy.paused),
    blocked: t('components.native-chat.goal.blocked', copy.blocked),
    limited: t('components.native-chat.goal.limited', copy.limited)
  }[key]
  const action = expanded
    ? t('components.native-chat.goal.collapse', copy.collapse)
    : t('components.native-chat.goal.expand', copy.expand)
  const elapsed = formatNativeChatDuration(
    agentSessionThreadGoalElapsedSeconds(goal, now - hostClockOffsetMs, runningTurn)
  )
  return (
    <View style={styles.strip} testID="thread-goal-banner">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${action}: ${label} — ${goal.objective}, ${elapsed}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <Goal size={14} color={colors.textMuted} />
        <Text style={styles.objective} numberOfLines={1}>
          <Text style={styles.label}>{label} </Text>
          {goal.objective}
        </Text>
        <Text style={styles.elapsed} importantForAccessibility="no" accessibilityElementsHidden>
          {elapsed}
        </Text>
        {expanded ? (
          <ChevronUp size={14} color={colors.textMuted} />
        ) : (
          <ChevronDown size={14} color={colors.textMuted} />
        )}
      </Pressable>
      <BottomDrawer
        fillAvailable
        visible={expanded}
        onClose={() => setExpanded(false)}
        scrollResetKey={goal.objective}
      >
        {controls ? (
          <View style={styles.actions}>
            {agentSessionThreadGoalStatusChange(goal.status) === 'paused' ? (
              <GoalAction
                label={t('components.native-chat.goal.pause', 'Pause goal')}
                controls={controls}
                onPress={() => void controls.change({ kind: 'status', status: 'paused' })}
                icon={<Pause size={16} color={colors.textSecondary} />}
              />
            ) : agentSessionThreadGoalStatusChange(goal.status) === 'active' ? (
              <GoalAction
                label={t('components.native-chat.goal.resume', 'Resume goal')}
                controls={controls}
                onPress={() => void controls.change({ kind: 'status', status: 'active' })}
                icon={<Play size={16} color={colors.textSecondary} />}
              />
            ) : null}
            <GoalAction
              label={t('components.native-chat.goal.clear', 'Clear goal')}
              controls={controls}
              onPress={() => void controls.change({ kind: 'clear' })}
              icon={<Trash2 size={16} color={colors.statusRed} />}
            />
          </View>
        ) : null}
        <Text style={[styles.fullObjective, styles.label]}>{label}</Text>
        <Text style={styles.fullObjective} selectable>
          {goal.objective}
        </Text>
      </BottomDrawer>
    </View>
  )
}

function GoalAction(props: {
  label: string
  controls: MobileThreadGoalControls
  onPress: () => void
  icon: React.ReactNode
}): React.JSX.Element {
  useMobileColorScheme()
  const disabled = props.controls.disabled || props.controls.pending
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled, busy: props.controls.pending }}
      disabled={disabled}
      onPress={() => {
        if (!disabled) {
          props.onPress()
        }
      }}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.pressed,
        disabled && styles.disabled
      ]}
    >
      <View style={styles.actionIcon}>
        {props.controls.pending ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : (
          props.icon
        )}
      </View>
      <Text style={styles.actionLabel}>{props.label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  actions: { gap: spacing.sm, padding: spacing.sm },
  actionIcon: {
    width: spacing.xl,
    height: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center'
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgPanel
  },
  actionLabel: { fontSize: typography.bodySize, color: colors.textPrimary },
  disabled: { opacity: 0.5 },
  strip: {
    marginHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderTopLeftRadius: radii.control,
    borderTopRightRadius: radii.control,
    backgroundColor: colors.bgPanel
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm },
  objective: { flex: 1, minWidth: 0, fontSize: typography.metaSize, color: colors.textSecondary },
  label: { fontWeight: '600', color: colors.textPrimary },
  elapsed: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  fullObjective: {
    padding: spacing.sm,
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  pressed: { opacity: 0.7 }
}))
