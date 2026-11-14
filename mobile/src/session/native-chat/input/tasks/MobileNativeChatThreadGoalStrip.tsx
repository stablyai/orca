import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronDown, Goal, Pause, Play, Trash2 } from 'lucide-react-native'
import {
  agentSessionThreadGoalElapsedSeconds,
  agentSessionThreadGoalStatusChange
} from '../../../../../../src/shared/agent-session/agent-session-thread-goal'
import {
  agentSessionThreadGoalStatusLabel,
  formatAgentSessionThreadGoalElapsed,
  type AgentSessionThreadGoalStatusLabel
} from '../../../../../../src/shared/agent-session/view/agent-session-thread-goal-presentation'
import { useNow } from '../../../../hooks/use-now'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { COMPOSER_TUCK } from '../../composer/field/mobile-native-chat-composer-styles'
import { queuedMessageStyles } from '../queued-messages/mobile-native-chat-queued-message-styles'
import type { MobileStructuredThreadGoal } from './use-mobile-structured-thread-goal'

type Translate = ReturnType<typeof useMobileTranslation>

function statusText(label: AgentSessionThreadGoalStatusLabel, t: Translate): string {
  switch (label) {
    case 'pursuing':
      return t('chat.goal.pursuing', 'Pursuing goal')
    case 'set':
      return t('chat.goal.set', 'Goal set')
    case 'paused':
      return t('chat.goal.paused', 'Paused goal')
    case 'blocked':
      return t('chat.goal.blocked', 'Goal blocked')
    case 'limited':
      return t('chat.goal.limited', 'Goal limited')
  }
}

/** The chat's goal on the composer's top edge: one line that expands in place to the full objective and its controls. */
export function MobileNativeChatThreadGoalStrip({
  threadGoal
}: {
  threadGoal: MobileStructuredThreadGoal
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [expanded, setExpanded] = useState(false)
  const { goal, runningTurn, changes, locked } = threadGoal
  const now = useNow(1_000, goal?.status === 'active' && runningTurn !== null)
  const label = goal ? agentSessionThreadGoalStatusLabel(goal.status, runningTurn !== null) : null
  if (!goal || label === null) {
    return null
  }
  const status = statusText(label, t)
  // Goal times are host-stamped; read them on the host's clock.
  const elapsed = formatAgentSessionThreadGoalElapsed(
    agentSessionThreadGoalElapsedSeconds(goal, now - threadGoal.hostClockOffsetMs, runningTurn)
  )
  const statusChange = changes === 'host' ? agentSessionThreadGoalStatusChange(goal.status) : null
  const toggleLabel = expanded
    ? t('chat.goal.collapse', 'Hide full goal')
    : t('chat.goal.expand', 'Show full goal')
  const toggle = (): void => setExpanded(!expanded)
  const chevron = (
    <View style={[styles.chevron, expanded && styles.chevronOpen]}>
      <ChevronDown size={14} color={colors.textMuted} strokeWidth={2} />
    </View>
  )
  return (
    <View style={[queuedMessageStyles.box, styles.tab]} testID="thread-goal-strip">
      {expanded ? (
        <>
          <View style={styles.openLine}>
            <View style={styles.openIcon}>
              <Goal size={14} color={colors.textMuted} strokeWidth={2} />
            </View>
            <ScrollView style={styles.objectiveScroll} nestedScrollEnabled>
              <Text style={[styles.text, styles.openText]}>
                <Text style={styles.status}>{status}</Text> {goal.objective}
                <Text style={styles.elapsed}>{` · ${elapsed}`}</Text>
              </Text>
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={toggleLabel}
              accessibilityState={{ expanded }}
              hitSlop={spacing.xs}
              style={({ pressed }) => [styles.chevronButton, pressed && styles.pressed]}
              onPress={toggle}
            >
              {chevron}
            </Pressable>
          </View>
          {changes !== null ? (
            <View style={styles.actions}>
              {statusChange !== null ? (
                <GoalAction
                  label={
                    statusChange === 'paused'
                      ? t('chat.goal.pause', 'Pause')
                      : t('chat.goal.resume', 'Resume')
                  }
                  disabled={locked}
                  onPress={() => void threadGoal.change({ kind: 'status', status: statusChange })}
                  icon={
                    statusChange === 'paused' ? (
                      <Pause size={13} color={colors.textPrimary} strokeWidth={2} />
                    ) : (
                      <Play size={13} color={colors.textPrimary} strokeWidth={2} />
                    )
                  }
                />
              ) : null}
              <GoalAction
                label={t('chat.goal.clear', 'Clear goal')}
                destructive
                disabled={threadGoal.clearLocked}
                onPress={() => void threadGoal.change({ kind: 'clear' })}
                icon={<Trash2 size={13} color={colors.statusRed} strokeWidth={2} />}
              />
            </View>
          ) : null}
        </>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${status} ${goal.objective}, ${elapsed}`}
          accessibilityHint={toggleLabel}
          accessibilityState={{ expanded }}
          style={({ pressed }) => [styles.line, pressed && styles.pressed]}
          onPress={toggle}
        >
          <Goal size={14} color={colors.textMuted} strokeWidth={2} />
          <Text style={[styles.text, styles.lineText]} numberOfLines={1} ellipsizeMode="tail">
            <Text style={styles.status}>{status}</Text> {goal.objective}
          </Text>
          <Text style={[styles.text, styles.elapsed]}>{elapsed}</Text>
          {chevron}
        </Pressable>
      )}
    </View>
  )
}

function GoalAction(props: {
  label: string
  icon: React.ReactNode
  disabled: boolean
  destructive?: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.actionPressed,
        props.disabled && styles.disabled
      ]}
      onPress={props.onPress}
    >
      {props.icon}
      <Text style={[styles.actionLabel, props.destructive && styles.destructive]}>
        {props.label}
      </Text>
    </Pressable>
  )
}

// Line height of the strip's meta text; the icon aligns with its first line.
const LINE_HEIGHT = 17
const LINE_MIN_HEIGHT = 34
const CHEVRON_SIZE = 32

const styles = themedStyleSheet(() => ({
  // The queued-message box, docked on the composer's top edge and tucked under it.
  tab: {
    marginHorizontal: spacing.xs,
    marginBottom: -COMPOSER_TUCK
  },
  line: {
    minHeight: LINE_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs
  },
  openLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs
  },
  openIcon: {
    paddingTop: (LINE_MIN_HEIGHT - 14) / 2
  },
  objectiveScroll: {
    flex: 1,
    maxHeight: 160
  },
  text: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: LINE_HEIGHT
  },
  lineText: {
    flex: 1,
    minWidth: 0
  },
  openText: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  status: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  elapsed: {
    fontVariant: ['tabular-nums']
  },
  chevronButton: {
    borderRadius: radii.pill
  },
  chevron: {
    width: CHEVRON_SIZE,
    height: CHEVRON_SIZE,
    alignItems: 'center',
    justifyContent: 'center'
  },
  chevronOpen: {
    transform: [{ rotate: '180deg' }]
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingLeft: spacing.md + 14 + spacing.sm,
    paddingTop: 2,
    paddingBottom: spacing.sm
  },
  action: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.composerControl
  },
  actionPressed: {
    backgroundColor: colors.bgRaised
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  destructive: {
    color: colors.statusRed
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.5
  }
}))
