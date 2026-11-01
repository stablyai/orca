import { useRef, useState } from 'react'
import { Animated, PanResponder, Pressable, Text, View } from 'react-native'
import { Ban, X } from 'lucide-react-native'
import type { NativeChatSubagentState } from '../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatSubagentActivity } from '../../../../../src/shared/native-chat/input/native-chat-activity'
import { nativeChatSubagentDismissible } from '../../../../../src/shared/native-chat/input/native-chat-subagent-dismissals'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

const SWIPE_DISMISS_DISTANCE = 72
const NO_COMPLETED: readonly NativeChatSubagentActivity[] = []

export function subagentRowSwipeDismisses(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_DISMISS_DISTANCE && Math.abs(dx) > Math.abs(dy)
}

function stateLabel(
  t: ReturnType<typeof useMobileTranslation>,
  state: NativeChatSubagentState
): string {
  switch (state) {
    case 'working':
      return t('chat.activity.state.working', 'Working')
    case 'completed':
      return t('chat.activity.state.completed', 'Completed')
    case 'idle':
      return t('chat.activity.state.idle', 'Idle')
    case 'failed':
      return t('chat.activity.state.failed', 'Failed')
    case 'stopped':
      return t('chat.activity.state.stopped', 'Stopped')
    case 'unverifiable':
      return t('chat.activity.state.unavailable', 'Status unavailable')
  }
}

export function MobileNativeChatSubagentSheet({
  agents,
  completed = NO_COMPLETED,
  showBack,
  focusedId,
  onChoose,
  onDismiss
}: {
  agents: readonly NativeChatSubagentActivity[]
  completed?: readonly NativeChatSubagentActivity[]
  showBack: boolean
  focusedId: string | null
  onChoose: (agentId: string | null) => void
  onDismiss: (agents: readonly NativeChatSubagentActivity[]) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [completedOpen, setCompletedOpen] = useState(false)
  const dismissible = agents.filter((agent) => nativeChatSubagentDismissible(agent.state))
  const dismissAll = t('chat.activity.dismissAllFailed', 'Dismiss all failed')
  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <Text style={styles.sheetTitle} numberOfLines={1}>
          {t('chat.activity.subagentsTitle', 'Subagents')}
        </Text>
        {dismissible.length >= 2 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dismissAll}
            testID="native-chat-dismiss-all-failed"
            hitSlop={8}
            onPress={() => onDismiss(dismissible)}
          >
            <Text style={styles.dismissAll} numberOfLines={1}>
              {dismissAll}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.group}>
        {showBack ? (
          <Choice
            label={t('chat.activity.backToMain', 'Main agent')}
            detail={t('chat.activity.backToConversation', 'Back to the conversation')}
            current={false}
            dismissLabel={null}
            onPress={() => onChoose(null)}
          />
        ) : null}
        {agents.map((agent, index) => (
          <View key={agent.id}>
            {showBack || index > 0 ? <View style={styles.separator} /> : null}
            <Choice
              label={agent.label}
              detail={agent.activity ?? t('chat.activity.noActivity', 'No activity yet')}
              status={stateLabel(t, agent.state)}
              failed={agent.state === 'failed' || agent.state === 'stopped'}
              current={agent.id === focusedId}
              dismissLabel={
                nativeChatSubagentDismissible(agent.state)
                  ? t('chat.activity.dismissSubagent', 'Dismiss {{name}}', { name: agent.label })
                  : null
              }
              onPress={() => onChoose(agent.id)}
              onDismiss={() => onDismiss([agent])}
            />
          </View>
        ))}
      </View>
      {completed.length > 0 ? (
        <View style={styles.group}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: completedOpen }}
            testID="native-chat-completed-subagents"
            onPress={() => setCompletedOpen((open) => !open)}
            style={styles.choice}
          >
            <Text style={styles.completedLabel}>
              {t('chat.activity.completedSubagents', 'Completed ({{count}})', {
                count: completed.length
              })}
            </Text>
          </Pressable>
          {completedOpen
            ? completed.map((agent) => (
                <View key={agent.id}>
                  <View style={styles.separator} />
                  <Choice
                    label={agent.label}
                    detail={agent.activity ?? t('chat.activity.noActivity', 'No activity yet')}
                    status={stateLabel(t, agent.state)}
                    current={agent.id === focusedId}
                    dismissLabel={null}
                    testID="native-chat-open-completed"
                    onPress={() => onChoose(agent.id)}
                  />
                </View>
              ))
            : null}
        </View>
      ) : null}
    </View>
  )
}

function Choice({
  label,
  detail,
  status,
  failed = false,
  current,
  dismissLabel,
  testID,
  onPress,
  onDismiss
}: {
  label: string
  detail: string
  status?: string
  failed?: boolean
  current: boolean
  dismissLabel: string | null
  testID?: string
  onPress: () => void
  onDismiss?: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const translateX = useRef(new Animated.Value(0)).current
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        dismissRef.current != null &&
        Math.abs(gesture.dx) > 8 &&
        Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_event, gesture) => {
        translateX.setValue(Math.max(-120, Math.min(120, gesture.dx)))
      },
      onPanResponderRelease: (_event, gesture) => {
        if (subagentRowSwipeDismisses(gesture.dx, gesture.dy)) {
          dismissRef.current?.()
          return
        }
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 8 }).start()
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, friction: 8 }).start()
      }
    })
  ).current
  return (
    <View {...(dismissLabel ? pan.panHandlers : undefined)}>
      <Animated.View style={{ transform: [{ translateX }] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: current }}
          testID={testID}
          onPress={onPress}
          style={[styles.choice, dismissLabel ? styles.choiceWithDismiss : null]}
        >
          <View style={styles.choiceTitleRow}>
            <Text style={styles.choiceLabel} numberOfLines={1}>
              {label}
            </Text>
            {status ? (
              <View style={styles.choiceStatusRow}>
                {failed ? <Ban size={12} color={colors.statusAmber} strokeWidth={2} /> : null}
                <Text style={[styles.choiceStatus, failed && styles.choiceFailed]}>{status}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.choiceDetail} numberOfLines={1}>
            {detail}
          </Text>
        </Pressable>
      </Animated.View>
      {dismissLabel && onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          testID="native-chat-dismiss-subagent"
          hitSlop={8}
          onPress={onDismiss}
          style={styles.dismiss}
        >
          <X size={14} color={colors.textMuted} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  sheet: {
    gap: spacing.sm,
    paddingBottom: spacing.sm
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sheetTitle: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  dismissAll: {
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  completedLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  group: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  choice: {
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  choiceWithDismiss: {
    paddingRight: spacing.xl + spacing.md
  },
  choiceTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  choiceLabel: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  choiceStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  choiceStatus: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  choiceFailed: {
    color: colors.statusAmber
  },
  choiceDetail: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  dismiss: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center'
  }
}))
