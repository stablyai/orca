import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { SHEET_CURVE } from '../components/sheet-motion-values'
import { useDrawerReducedMotion } from '../components/bottom-drawer-constants'
import { Minus, Plus, Undo2 } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { STATUS_LABELS } from '../../../src/shared/git-status-labels'
import type { GitConflictKind, GitFileStatus } from '../../../src/shared/git-status-types'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileDiffLineStats } from '../components/MobileDiffReviewFileSummary'
import type {
  MobileBranchEntryView,
  MobileGitStatusEntryView
} from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'
import { mobileConflictResolutionLabel } from './mobile-source-control-conflict-actions'
import { getUnstageablePaths, statusColor } from './mobile-git-status'

export type FileRowState = Pick<
  MobileSourceControlState,
  'busyAction' | 'openDiffForFile' | 'resolveConflict' | 'runGitAction' | 'setDiscardTarget'
>

function conflictKindLabel(kind: GitConflictKind | undefined, t: Translate): string {
  switch (kind) {
    case 'both_modified':
      return t('sourceControl.fileRows.bothModified', 'Both modified')
    case 'both_added':
      return t('sourceControl.fileRows.bothAdded', 'Both added')
    case 'deleted_by_us':
      return t('sourceControl.fileRows.deletedByUs', 'Deleted by us')
    case 'deleted_by_them':
      return t('sourceControl.fileRows.deletedByThem', 'Deleted by them')
    case 'added_by_us':
      return t('sourceControl.fileRows.addedByUs', 'Added by us')
    case 'added_by_them':
      return t('sourceControl.fileRows.addedByThem', 'Added by them')
    case 'both_deleted':
      return t('sourceControl.fileRows.bothDeleted', 'Both deleted')
    default:
      return t('sourceControl.fileRows.unresolvedConflict', 'Unresolved conflict')
  }
}

// Git paths always use '/'; the name leads so it never truncates behind its folder.
function splitGitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { name: path, folder: '' }
    : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}

/** Status letter, file name over its folder, then the row's stats and action. */
function FileRowBody({
  status,
  path,
  detail,
  added,
  removed,
  trailing,
  actions
}: {
  status: GitFileStatus
  path: string
  /** Leads the folder line, e.g. a conflict kind or a rename source. */
  detail?: string
  added?: number
  removed?: number
  trailing?: ReactNode
  /** Wrapping buttons under the name, e.g. a conflict's resolutions, so the name keeps its width. */
  actions?: ReactNode
}) {
  useMobileColorScheme()
  const { name, folder } = splitGitPath(path)
  const subtitle = detail ? (folder ? `${detail} · ${folder}` : detail) : folder
  return (
    <>
      <View style={styles.statusBadge}>
        <Text style={[styles.statusBadgeText, { color: statusColor(status) }]}>
          {STATUS_LABELS[status]}
        </Text>
      </View>
      <View style={styles.fileTextBlock}>
        <Text
          style={[styles.fileName, status === 'deleted' && styles.fileNameGone]}
          numberOfLines={1}
        >
          {name}
        </Text>
        {subtitle ? (
          <Text style={styles.fileMeta} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {actions ? <View style={styles.conflictActions}>{actions}</View> : null}
      </View>
      <MobileDiffLineStats added={added} removed={removed} />
      {trailing}
    </>
  )
}

// The width the Discard action uncovers; a swipe past half of it settles open.
const DISCARD_WIDTH = 84
const SWIPE_SETTLE_MS = 250
const DRAG_CLICK_WINDOW_MS = 400

/** Discard sits behind a left swipe and still asks first; it is also on the diff screen. */
function SwipeToDiscard({
  available,
  enabled,
  label,
  accessibilityLabel,
  onDiscard,
  children
}: {
  /** Only discardable rows get the swipe; toggling it would remount the row. */
  available: boolean
  enabled: boolean
  label: string
  accessibilityLabel: string
  onDiscard: () => void
  /** Gets a wrapper for the row's press: a tap on a swiped row closes it instead. */
  children: (guardPress: (onPress: () => void) => () => void) => ReactNode
}) {
  useMobileColorScheme()
  const reducedMotion = useDrawerReducedMotion()
  const offset = useSharedValue(0)
  const start = useSharedValue(0)
  // When the last drag ended: on the web, releasing a mouse drag also clicks the row.
  const dragEndedAt = useSharedValue(0)
  // Built per render: a module-level easing would run before a test's Reanimated mock can serve it.
  const settle = (to: number) => {
    'worklet'
    return withTiming(
      to,
      reducedMotion
        ? { duration: 0, reduceMotion: ReduceMotion.Never }
        : { duration: SWIPE_SETTLE_MS, easing: Easing.bezier(...SHEET_CURVE) }
    )
  }
  // Horizontal only, so the list keeps scrolling under a vertical drag.
  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onBegin(() => {
      start.value = offset.value
    })
    .onUpdate((event) => {
      offset.value = Math.min(0, Math.max(-DISCARD_WIDTH, start.value + event.translationX))
    })
    .onEnd(() => {
      // oxlint-disable-next-line react/purity -- runs when the drag ends, never during render.
      dragEndedAt.value = Date.now()
      offset.value = settle(offset.value < -DISCARD_WIDTH / 2 ? -DISCARD_WIDTH : 0)
    })
  // Web has no worklet plugin; mapper hooks need this explicit dependency list.
  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }), [offset])
  // A tap on an open row closes it rather than opening the diff.
  const guardPress = (onPress: () => void) => () => {
    // The click a drag release produces belongs to the drag, not to the row.
    if (Date.now() - dragEndedAt.value < DRAG_CLICK_WINDOW_MS) {
      return
    }
    if (offset.value !== 0) {
      offset.value = settle(0)
      return
    }
    onPress()
  }
  if (!available) {
    return children((onPress) => onPress)
  }
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.discardAction, pressed && styles.iconButtonPressed]}
        disabled={!enabled}
        onPress={() => {
          offset.value = settle(0)
          onDiscard()
        }}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        <Undo2 size={17} color={colors.onStatusRed} strokeWidth={2.2} />
        <Text style={styles.discardActionText}>{label}</Text>
      </Pressable>
      {/* pan-y keeps the page scrolling vertically over the row on the web. */}
      <GestureDetector gesture={pan} touchAction="pan-y">
        <Animated.View style={rowStyle}>{children(guardPress)}</Animated.View>
      </GestureDetector>
    </View>
  )
}

export function ChangeFileRow({
  item,
  state
}: {
  item: MobileGitStatusEntryView
  state: FileRowState
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { busyAction, openDiffForFile, resolveConflict, runGitAction, setDiscardTarget } = state
  const rowBusy =
    busyAction === item.stageActionId ||
    busyAction === item.unstageActionId ||
    busyAction === item.discardActionId ||
    busyAction === item.resolveActionId
  const ioBusy = busyAction !== null
  const hasConflictActions = item.conflictResolutions.length > 0
  const detail = item.oldPath
    ? t('sourceControl.fileRows.renamedFrom', 'from {{path}}', { path: item.oldPath })
    : item.conflictStatus === 'unresolved'
      ? conflictKindLabel(item.conflictKind, t)
      : undefined
  const stage = () => void runGitAction(item.stageActionId, 'git.stage', { filePath: item.path })
  const unstage = () => {
    const filePaths = getUnstageablePaths([item])
    void (filePaths.length > 1
      ? runGitAction(item.unstageActionId, 'git.bulkUnstage', { filePaths })
      : runGitAction(item.unstageActionId, 'git.unstage', { filePath: item.path }))
  }
  // Every press in the row goes through the swipe's guard, so a drag never also presses a button.
  const conflictActions = (guard: (onPress: () => void) => () => void) =>
    !rowBusy && hasConflictActions
      ? item.conflictResolutions.map((resolution) => (
          <Pressable
            key={resolution}
            style={({ pressed }) => [
              styles.conflictActionButton,
              ioBusy && styles.iconButtonDisabled,
              pressed && styles.iconButtonPressed
            ]}
            disabled={ioBusy}
            onPress={guard(() => void resolveConflict(item, resolution))}
            hitSlop={4}
            accessibilityLabel={t(
              'sourceControl.conflictActions.resolveFile',
              '{{action}}: {{path}}',
              {
                action: mobileConflictResolutionLabel(resolution, t),
                path: item.path
              }
            )}
          >
            <Text style={styles.conflictActionText}>
              {mobileConflictResolutionLabel(resolution, t)}
            </Text>
          </Pressable>
        ))
      : null
  const trailing = (guard: (onPress: () => void) => () => void) =>
    rowBusy ? (
      <ActivityIndicator size="small" color={colors.textSecondary} />
    ) : !hasConflictActions && (item.canUnstage || item.canStage) ? (
      <Pressable
        style={({ pressed }) => [
          styles.iconButton,
          ioBusy && styles.iconButtonDisabled,
          pressed && styles.iconButtonPressed
        ]}
        disabled={ioBusy}
        onPress={guard(item.canUnstage ? unstage : stage)}
        hitSlop={8}
        accessibilityLabel={
          item.canUnstage
            ? t('sourceControl.fileRows.unstageFile', 'Unstage {{path}}', { path: item.path })
            : t('sourceControl.fileRows.stageFile', 'Stage {{path}}', { path: item.path })
        }
      >
        {item.canUnstage ? (
          <Minus size={18} color={colors.textSecondary} strokeWidth={2.2} />
        ) : (
          <Plus size={18} color={colors.textSecondary} strokeWidth={2.2} />
        )}
      </Pressable>
    ) : null
  return (
    <SwipeToDiscard
      available={item.canDiscard}
      enabled={!ioBusy}
      label={t('sourceControl.fileRows.discard', 'Discard')}
      accessibilityLabel={t('sourceControl.fileRows.discardFile', 'Discard {{path}}', {
        path: item.path
      })}
      onDiscard={() => setDiscardTarget(item)}
    >
      {(guardPress) => (
        <Pressable
          style={({ pressed }) => [
            styles.fileRow,
            pressed && item.canOpen && styles.fileRowPressed,
            !item.canOpen && !hasConflictActions && styles.fileRowUnavailable
          ]}
          onPress={guardPress(() => {
            if (item.area !== undefined) {
              openDiffForFile({ kind: 'changes', filePath: item.path, area: item.area })
            }
          })}
          disabled={!item.canOpen || ioBusy}
          // An accessible row hides nested buttons from iOS VoiceOver; conflict rows cannot open anyway.
          accessible={!hasConflictActions}
          accessibilityLabel={t(
            'sourceControl.fileRows.openChangedFile',
            'Open changed file {{path}}',
            {
              path: item.path
            }
          )}
        >
          <FileRowBody
            status={item.status}
            path={item.path}
            detail={detail}
            added={item.added}
            removed={item.removed}
            trailing={trailing(guardPress)}
            actions={conflictActions(guardPress)}
          />
        </Pressable>
      )}
    </SwipeToDiscard>
  )
}

export function BranchFileRow({
  entry,
  state
}: {
  entry: MobileBranchEntryView
  state: Pick<FileRowState, 'busyAction' | 'openDiffForFile'>
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      style={({ pressed }) => [
        styles.fileRow,
        pressed && entry.canOpen && styles.fileRowPressed,
        !entry.canOpen && styles.fileRowUnavailable
      ]}
      onPress={() =>
        state.openDiffForFile({ kind: 'changes', filePath: entry.path, area: 'branch' })
      }
      disabled={!entry.canOpen || state.busyAction !== null}
      accessibilityLabel={t(
        'sourceControl.fileRows.openCommittedChange',
        'Open committed change {{path}}',
        { path: entry.path }
      )}
    >
      <FileRowBody
        status={entry.status}
        path={entry.path}
        detail={
          entry.oldPath
            ? t('sourceControl.fileRows.renamedFrom', 'from {{path}}', { path: entry.oldPath })
            : undefined
        }
        added={entry.added}
        removed={entry.removed}
      />
    </Pressable>
  )
}
