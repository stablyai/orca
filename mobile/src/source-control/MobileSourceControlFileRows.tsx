import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SwipeRowActions } from '../components/SwipeRowActions'
import { Minus, Plus, Undo2 } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { STATUS_LABELS } from '../../../src/shared/git/status/git-status-labels'
import type {
  GitConflictKind,
  GitFileStatus
} from '../../../src/shared/git/status/git-status-types'
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
    // Discard sits behind a left swipe and still asks first; it is also on the diff screen.
    <SwipeRowActions
      enabled={!ioBusy}
      trailing={
        item.canDiscard
          ? {
              label: t('sourceControl.fileRows.discard', 'Discard'),
              accessibilityLabel: t('sourceControl.fileRows.discardFile', 'Discard {{path}}', {
                path: item.path
              }),
              icon: Undo2,
              background: colors.statusRed,
              foreground: colors.onStatusRed,
              onPress: () => setDiscardTarget(item)
            }
          : undefined
      }
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
    </SwipeRowActions>
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
