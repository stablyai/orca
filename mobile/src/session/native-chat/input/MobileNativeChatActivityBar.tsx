import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Ban, ChevronLeft, ListChecks, Users } from 'lucide-react-native'
import type { NativeChatSubagentState } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  nativeChatCompletedTaskCount,
  type NativeChatTaskList
} from '../../../../../src/shared/native-chat/input/native-chat-task-list'
import {
  nativeChatListedSubagents,
  type NativeChatSubagentActivity
} from '../../../../../src/shared/native-chat/input/native-chat-activity'
import { BottomDrawer } from '../../../components/BottomDrawer'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatTaskList } from './MobileNativeChatTaskList'

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

export function MobileNativeChatActivityBar({
  list,
  subagents,
  focused,
  focusedTranscriptEmpty,
  fontScale,
  onFocusSubagent
}: {
  list: NativeChatTaskList | null
  subagents: readonly NativeChatSubagentActivity[]
  focused: NativeChatSubagentActivity | null
  focusedTranscriptEmpty: boolean
  fontScale: number
  onFocusSubagent: (agentId: string | null) => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [tasksOpen, setTasksOpen] = useState(false)
  const [subagentsOpen, setSubagentsOpen] = useState(false)
  const listed = nativeChatListedSubagents(subagents)
  const showTasks = list != null && list.tasks.length > 0
  if (!showTasks && listed.length === 0 && !focused) {
    return null
  }
  const completed = list ? nativeChatCompletedTaskCount(list) : 0
  const total = list?.tasks.length ?? 0
  const working = listed.some((agent) => agent.state === 'working')
  const taskLabel =
    total === 1
      ? t('chat.activity.taskPill', '{{completed}}/{{count}} task', { completed, count: total })
      : t('chat.activity.tasksPill', '{{completed}}/{{count}} tasks', { completed, count: total })
  const subagentLabel =
    listed.length === 1
      ? t('chat.activity.subagentPill', '{{count}} subagent', { count: listed.length })
      : t('chat.activity.subagentsPill', '{{count}} subagents', { count: listed.length })
  return (
    <View style={styles.bar}>
      {focused ? (
        <View style={styles.banner}>
          <View style={styles.bannerText}>
            <Text style={styles.bannerTitle} numberOfLines={1}>
              {t('chat.activity.viewingSubagent', 'Viewing {{name}}', { name: focused.label })}
            </Text>
            <Text style={styles.bannerMeta}>
              {t('chat.activity.composerStays', 'The composer still sends to the main agent.')}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onFocusSubagent(null)}
            style={styles.bannerAction}
          >
            <ChevronLeft size={14} color={colors.textPrimary} strokeWidth={2} />
            <Text style={styles.bannerActionText}>
              {t('chat.activity.backToMain', 'Main agent')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {focused && focusedTranscriptEmpty ? (
        <Text style={styles.bannerMeta}>
          {t('chat.activity.noMessages', 'No messages from this subagent yet')}
        </Text>
      ) : null}
      <View style={styles.pills}>
        {showTasks && list ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: tasksOpen }}
            accessibilityLabel={t('chat.activity.openTasks', 'Tasks, {{label}}', {
              label: taskLabel
            })}
            testID="native-chat-tasks-pill"
            onPress={() => {
              setSubagentsOpen(false)
              setTasksOpen(true)
            }}
            style={styles.pill}
          >
            <ListChecks size={14} color={colors.textSecondary} strokeWidth={2} />
            <Text style={styles.pillText}>{taskLabel}</Text>
            <View style={styles.track}>
              <View
                style={[styles.fill, { width: `${total === 0 ? 0 : (completed / total) * 100}%` }]}
              />
            </View>
          </Pressable>
        ) : null}
        {listed.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: subagentsOpen }}
            accessibilityLabel={t('chat.activity.openSubagents', 'Subagents, {{label}}', {
              label: subagentLabel
            })}
            testID="native-chat-subagents-pill"
            onPress={() => {
              setTasksOpen(false)
              setSubagentsOpen(true)
            }}
            style={styles.pill}
          >
            <Users size={14} color={colors.textSecondary} strokeWidth={2} />
            <Text style={styles.pillText}>{subagentLabel}</Text>
            {working ? <View style={styles.dot} /> : null}
          </Pressable>
        ) : null}
      </View>
      <BottomDrawer visible={tasksOpen} onClose={() => setTasksOpen(false)} dragContentToDismiss>
        {list ? (
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{t('chat.taskList.title', 'Tasks')}</Text>
            <MobileNativeChatTaskList list={list} fontScale={fontScale} variant="sheet" />
          </View>
        ) : null}
      </BottomDrawer>
      <BottomDrawer
        visible={subagentsOpen}
        onClose={() => setSubagentsOpen(false)}
        dragContentToDismiss
      >
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{t('chat.activity.subagentsTitle', 'Subagents')}</Text>
          <View style={styles.group}>
            {focused ? (
              <Choice
                label={t('chat.activity.backToMain', 'Main agent')}
                detail={t('chat.activity.backToConversation', 'Back to the conversation')}
                current={false}
                onPress={() => {
                  setSubagentsOpen(false)
                  onFocusSubagent(null)
                }}
              />
            ) : null}
            {listed.map((agent, index) => (
              <View key={agent.id}>
                {focused || index > 0 ? <View style={styles.separator} /> : null}
                <Choice
                  label={agent.label}
                  detail={agent.activity ?? t('chat.activity.noActivity', 'No activity yet')}
                  status={stateLabel(t, agent.state)}
                  failed={agent.state === 'failed' || agent.state === 'stopped'}
                  current={agent.id === focused?.id}
                  onPress={() => {
                    setSubagentsOpen(false)
                    onFocusSubagent(agent.id)
                  }}
                />
              </View>
            ))}
          </View>
        </View>
      </BottomDrawer>
    </View>
  )
}

function Choice({
  label,
  detail,
  status,
  failed = false,
  current,
  onPress
}: {
  label: string
  detail: string
  status?: string
  failed?: boolean
  current: boolean
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: current }}
      onPress={onPress}
      style={styles.choice}
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
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  bannerText: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  bannerTitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  bannerMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  bannerAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.composerControl,
    borderRadius: radii.control
  },
  bannerActionText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 28,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.composerControl
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  track: {
    width: 32,
    height: 4,
    borderRadius: radii.pill,
    overflow: 'hidden',
    backgroundColor: colors.translucentFill
  },
  fill: {
    height: '100%',
    backgroundColor: colors.textPrimary
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  },
  sheet: {
    gap: spacing.sm,
    paddingBottom: spacing.sm
  },
  sheetTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
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
  }
}))
