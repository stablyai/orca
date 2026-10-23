import { memo, useMemo, useState } from 'react'
import {
  Dimensions,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import {
  Activity,
  Bot,
  ChevronDown,
  CircleHelp,
  SquareTerminal,
  Workflow
} from 'lucide-react-native'
import type { AgentChildRowModel } from '../../../src/shared/agent-child-row-model'
import type { AgentSessionBackgroundTask } from '../../../src/shared/agent-session-wire'
import { sayBackgroundTaskEnglish as say } from '../../../src/shared/background-task-copy'
import {
  backgroundTasksHeaderContent,
  backgroundTasksHeaderText,
  NARROW_BACKGROUND_TASKS_STRIP_REM
} from '../../../src/shared/background-task-header-content'
import {
  backgroundTaskGroupLabel,
  backgroundTaskRowMeta,
  backgroundTaskRowStopId,
  backgroundTasksStripTicks,
  buildBackgroundTaskGroups,
  buildBackgroundTaskGroupsFromViews
} from '../../../src/shared/background-task-roster'
import { AGENT_WORKING_COLOR, AgentStateDot } from '../components/AgentStateDot'
import { useNow } from '../hooks/use-now'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles, typography } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'
import { composerTrayStyles } from './mobile-native-chat-composer-styles'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'
import {
  useMobileBackgroundTaskStops,
  type MobileBackgroundTaskStopping as Stopping
} from './use-mobile-background-task-stops'
import { mobileAgentChildRowName, mobileAgentChildRowText } from './mobile-agent-child-row-text'

type TaskKind = AgentSessionBackgroundTask['kind']

function KindIcon({ kind, size }: { kind: TaskKind; size: number }): React.JSX.Element {
  const props = { size, color: kindIconColor(kind), strokeWidth: 2 }
  switch (kind) {
    case 'agent':
      return <Bot {...props} />
    case 'command':
      return <SquareTerminal {...props} />
    case 'monitor':
      return <Activity {...props} />
    case 'workflow':
      return <Workflow {...props} />
    case 'unknown':
      return <CircleHelp {...props} />
  }
}

// React Native has no root font; its points stand in for desktop's 16 px rem.
const NARROW_STRIP_WIDTH = NARROW_BACKGROUND_TASKS_STRIP_REM * 16

// Monitoring is drawn in the same amber everywhere it shows; the other kinds are plain markers.
function kindIconColor(kind: TaskKind): string {
  return kind === 'monitor' ? AGENT_WORKING_COLOR : colors.textMuted
}

function TaskRow({
  row,
  now,
  hostNow,
  supportsTaskStop,
  stopping,
  onStop
}: {
  row: AgentChildRowModel
  now: number
  /** `now` on the host's clock, which stamps every elapsed anchor. */
  hostNow: number
  supportsTaskStop: boolean
  stopping: Stopping
  onStop: (taskId: string) => void
}): React.JSX.Element {
  const { lead, trail } = mobileAgentChildRowText(row, now)
  const meta = backgroundTaskRowMeta(row, hostNow)
  const stopId = backgroundTaskRowStopId(row, supportsTaskStop)
  const busy = stopId !== null && stopping.taskIds.has(stopId)
  return (
    <>
      <View testID="background-task-row" style={styles.row}>
        <KindIcon kind={row.kind} size={16} />
        <AgentStateDot state={row.displayState} />
        <Text style={styles.rowText} numberOfLines={1} ellipsizeMode="tail">
          <Text style={styles.lead}>{lead}</Text>
          {trail ? <Text style={styles.trail}>{` · ${trail}`}</Text> : null}
        </Text>
        {meta ? (
          // Reticks every second; screen readers hear the row's state, not its clock.
          <Text style={styles.meta} importantForAccessibility="no" accessibilityElementsHidden>
            {meta}
          </Text>
        ) : null}
        {stopId !== null ? (
          <Button
            label={say('stop')}
            size="compact"
            accessibilityLabel={say('stopTask', { value0: mobileAgentChildRowName(row) })}
            busy={busy}
            onPress={() => onStop(stopId)}
          />
        ) : null}
      </View>
      {row.owned.length > 0 ? (
        // Work a child owns (its shell, a nested agent) reads beneath it, not in its kind's group.
        <View style={styles.owned}>
          {row.owned.map((owned) => (
            <TaskRow
              key={owned.id}
              row={owned}
              now={now}
              hostNow={hostNow}
              supportsTaskStop={supportsTaskStop}
              stopping={stopping}
              onStop={onStop}
            />
          ))}
        </View>
      ) : null}
    </>
  )
}

/** The session's running child work — agents, shells, monitors, workflows — as one collapsible box
 *  above the composer. Desktop parity: `NativeChatBackgroundTasksStatus`, from the same host roster
 *  and the same shared grouping, header and Stop rules. Mounted per conversation, so its open and
 *  stopping state outlive the moment a sequential fan-out's roster empties between children. */
function MobileNativeChatBackgroundTasksImpl({
  tasks
}: {
  tasks: MobileStructuredBackgroundTasks
}): React.JSX.Element | null {
  const { view, rowContext } = tasks
  const [expanded, setExpanded] = useState(false)
  // Before the first layout, the window less the strip's own margins, so it opens in its final form.
  const [narrow, setNarrow] = useState(
    () => Dimensions.get('window').width - 2 * spacing.lg < NARROW_STRIP_WIDTH
  )
  const { stopping, onStop } = useMobileBackgroundTaskStops(tasks)
  const groups = useMemo(
    () =>
      view.children !== undefined
        ? buildBackgroundTaskGroupsFromViews(view.children, rowContext)
        : buildBackgroundTaskGroups(view.tasks, view.settledTasks, say),
    [view.children, view.tasks, view.settledTasks, rowContext]
  )
  const now = useNow(1_000, view.show && backgroundTasksStripTicks(groups, expanded))
  if (!view.show) {
    return null
  }
  // Elapsed anchors are host-stamped; read them on the host's clock, as the turn bar's start is.
  const hostNow = now - rowContext.hostClockOffsetMs
  const header = backgroundTasksHeaderContent(groups, { narrow, now: hostNow }, say)

  const onLayout = (event: LayoutChangeEvent): void => {
    setNarrow(event.nativeEvent.layout.width < NARROW_STRIP_WIDTH)
  }

  return (
    <View style={composerTrayStyles.layer} onLayout={onLayout} testID="background-tasks-strip">
      <View style={composerTrayStyles.panel}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={backgroundTasksHeaderText(header)}
          style={({ pressed }) => [
            styles.header,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
          onPress={() => setExpanded(!expanded)}
        >
          <View style={styles.headerText}>
            {header.segments.map((segment, index) => {
              return (
                <View key={segment.kind ?? 'total'} style={styles.segment}>
                  {index > 0 ? <Text style={styles.separator}>·</Text> : null}
                  {segment.kind ? (
                    // The turn owns the voice: same icons, dimmed until it ends.
                    <View style={view.isMonitoring ? undefined : styles.dimmed}>
                      <KindIcon kind={segment.kind} size={14} />
                    </View>
                  ) : null}
                  <Text style={styles.segmentText} numberOfLines={1} ellipsizeMode="tail">
                    {segment.text}
                  </Text>
                </View>
              )
            })}
            {header.detail ? (
              <Text style={styles.detail} numberOfLines={1} ellipsizeMode="tail">
                {header.segments.length > 0 ? `— ${header.detail}` : header.detail}
              </Text>
            ) : null}
          </View>
          <View style={[expanded ? styles.caretOpen : styles.caretClosed, slideTransition]}>
            <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
          </View>
        </Pressable>
        <Collapsible open={expanded}>
          <ScrollView style={styles.body} nestedScrollEnabled>
            {groups.length > 0 ? (
              groups.map((group) => (
                <View key={group.kind} style={styles.group}>
                  <Text style={styles.groupLabel}>{backgroundTaskGroupLabel(group.kind, say)}</Text>
                  {group.tasks.map((entry) => (
                    <TaskRow
                      key={entry.row.id}
                      row={entry.row}
                      now={now}
                      hostNow={hostNow}
                      supportsTaskStop={view.supportsStop}
                      stopping={stopping}
                      onStop={onStop}
                    />
                  ))}
                </View>
              ))
            ) : (
              <Text style={styles.unavailable}>{say('detailsUnavailable')}</Text>
            )}
            {view.incomplete && groups.length > 0 ? (
              <Text style={styles.unavailable}>{say('detailsUnavailable')}</Text>
            ) : null}
            {view.offersStopAll ? (
              <View style={styles.stopAll}>
                <Button
                  label={say('stop')}
                  size="compact"
                  accessibilityLabel={say('stopAll')}
                  busy={stopping.all}
                  onPress={() => onStop()}
                />
              </View>
            ) : null}
          </ScrollView>
        </Collapsible>
      </View>
    </View>
  )
}

export const MobileNativeChatBackgroundTasks = memo(MobileNativeChatBackgroundTasksImpl)

const styles = StyleSheet.create({
  header: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    overflow: 'hidden'
  },
  // Every piece may shrink, so large Dynamic Type ellipsizes the header instead of clipping it.
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
    minWidth: 0
  },
  separator: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  segmentText: {
    ...textStyles.footnote,
    fontWeight: '500',
    flexShrink: 1,
    color: colors.textPrimary
  },
  detail: {
    ...textStyles.footnote,
    flexShrink: 1,
    color: colors.textMuted
  },
  dimmed: {
    opacity: 0.4
  },
  caretOpen: {
    transform: [{ rotate: '180deg' }]
  },
  caretClosed: {
    transform: [{ rotate: '0deg' }]
  },
  body: {
    maxHeight: 260,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  },
  group: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs
  },
  groupLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted,
    paddingBottom: spacing.xs
  },
  row: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  owned: {
    marginLeft: spacing.lg
  },
  rowText: {
    ...textStyles.subhead,
    flex: 1,
    minWidth: 0
  },
  lead: {
    color: colors.textPrimary,
    fontWeight: '500'
  },
  trail: {
    color: colors.textMuted
  },
  meta: {
    color: colors.textMuted,
    fontSize: 13,
    fontFamily: typography.monoFamily,
    fontVariant: ['tabular-nums']
  },
  unavailable: {
    ...textStyles.subhead,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  stopAll: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  pressed: {
    backgroundColor: colors.fill
  }
})
