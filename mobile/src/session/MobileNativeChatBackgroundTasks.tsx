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
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
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
        <KindIcon kind={row.kind} size={14} />
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={say('stopTask', { value0: mobileAgentChildRowName(row) })}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            hitSlop={6}
            style={({ pressed }) => [
              styles.textAction,
              pressed && styles.pressed,
              busy && styles.disabled
            ]}
            onPress={() => onStop(stopId)}
          >
            <Text style={styles.actionLabel}>{say('stop')}</Text>
          </Pressable>
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
    <View style={styles.list} onLayout={onLayout} testID="background-tasks-strip">
      <View style={styles.box}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={backgroundTasksHeaderText(header)}
          hitSlop={spacing.xs}
          style={({ pressed }) => [styles.header, pressed && styles.pressed]}
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
                      <KindIcon kind={segment.kind} size={12} />
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
          <View style={expanded ? styles.caretOpen : undefined}>
            <ChevronDown size={14} color={colors.textMuted} strokeWidth={2} />
          </View>
        </Pressable>
        {expanded ? (
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
            {!view.supportsStop && view.supportsStopAll ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={say('stopAll')}
                accessibilityState={{ disabled: stopping.all }}
                disabled={stopping.all}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.textAction,
                  styles.stopAll,
                  pressed && styles.pressed,
                  stopping.all && styles.disabled
                ]}
                onPress={() => onStop()}
              >
                <Text style={styles.actionLabel}>{say('stop')}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        ) : null}
      </View>
    </View>
  )
}

export const MobileNativeChatBackgroundTasks = memo(MobileNativeChatBackgroundTasksImpl)

// hitSlop requests 44pt hit rects; compact native parent bounds still limit their reach.
const MIN_TOUCH_TARGET = 44

const styles = StyleSheet.create({
  list: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs
  },
  box: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  header: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md
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
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  segmentText: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  detail: {
    flexShrink: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  dimmed: {
    opacity: 0.4
  },
  caretOpen: {
    transform: [{ rotate: '180deg' }]
  },
  body: {
    maxHeight: 220,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  group: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs
  },
  groupLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: typography.monoFamily,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingBottom: spacing.xs / 2
  },
  row: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  owned: {
    marginLeft: spacing.lg
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.metaSize
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
    fontSize: 10,
    fontFamily: typography.monoFamily
  },
  unavailable: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    padding: spacing.md
  },
  textAction: {
    minHeight: 32,
    minWidth: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button
  },
  stopAll: {
    alignSelf: 'flex-start',
    marginHorizontal: spacing.sm
  },
  actionLabel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.5
  }
})
