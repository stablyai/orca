import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, FileText, Minus, Plus, Trash2 } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { STATUS_LABELS } from '../../../src/shared/git-status-labels'
import type { GitConflictKind } from '../../../src/shared/git-status-types'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { formatMobileBranchEntryMeta } from './mobile-branch-entry-format'
import {
  statusColor,
  type MobileBranchEntryView,
  type MobileGitStatusEntryView
} from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'
import { mobileConflictResolutionLabel } from './mobile-source-control-conflict-actions'
import { getUnstageablePaths } from './mobile-git-status'

type RowState = Pick<
  MobileSourceControlState,
  | 'busyAction'
  | 'openingPath'
  | 'openingBranchPath'
  | 'openFile'
  | 'resolveConflict'
  | 'runGitAction'
  | 'setDiscardTarget'
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

export function makeRenderFileRow(state: RowState, t: Translate) {
  const {
    busyAction,
    openingPath,
    openingBranchPath,
    openFile,
    resolveConflict,
    runGitAction,
    setDiscardTarget
  } = state
  return function renderFileRow({ item }: { item: MobileGitStatusEntryView }) {
    const rowBusy =
      busyAction === item.stageActionId ||
      busyAction === item.unstageActionId ||
      busyAction === item.discardActionId ||
      busyAction === item.resolveActionId ||
      openingPath === item.path
    const rowDisabled =
      !item.canOpen || busyAction !== null || openingPath !== null || openingBranchPath !== null
    const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null
    const hasConflictActions = item.conflictResolutions.length > 0
    return (
      <Pressable
        style={({ pressed }) => [
          styles.fileRow,
          pressed && item.canOpen && styles.fileRowPressed,
          // Conflict rows cannot open but carry live actions; their buttons dim themselves while busy.
          rowDisabled && !hasConflictActions && styles.fileRowDisabled,
          !item.canOpen && !hasConflictActions && styles.fileRowUnavailable
        ]}
        onPress={() => void openFile(item)}
        disabled={rowDisabled}
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
        <View style={styles.statusBadge}>
          <Text style={[styles.statusBadgeText, { color: statusColor(item.status) }]}>
            {STATUS_LABELS[item.status]}
          </Text>
        </View>
        <FileText
          size={16}
          color={item.canOpen ? colors.textSecondary : colors.textMuted}
          strokeWidth={2.1}
        />
        <View style={styles.fileTextBlock}>
          <Text
            style={[styles.filePath, !item.canOpen && styles.filePathDisabled]}
            numberOfLines={1}
          >
            {item.path}
          </Text>
          {item.oldPath ? (
            <Text style={styles.fileMeta} numberOfLines={1}>
              {t('sourceControl.fileRows.renamedFrom', 'from {{path}}', { path: item.oldPath })}
            </Text>
          ) : item.conflictStatus === 'unresolved' ? (
            <Text style={styles.fileMeta} numberOfLines={1}>
              {conflictKindLabel(item.conflictKind, t)}
            </Text>
          ) : null}
          {!rowBusy && hasConflictActions ? (
            <View style={styles.conflictActions}>
              {item.conflictResolutions.map((resolution) => (
                <Pressable
                  key={resolution}
                  style={({ pressed }) => [
                    styles.conflictActionButton,
                    ioBusy && styles.iconButtonDisabled,
                    pressed && styles.iconButtonPressed
                  ]}
                  disabled={ioBusy}
                  onPress={() => void resolveConflict(item, resolution)}
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
              ))}
            </View>
          ) : null}
        </View>
        {rowBusy ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : item.canUnstage ? (
          <Pressable
            style={({ pressed }) => [
              styles.iconButton,
              ioBusy && styles.iconButtonDisabled,
              pressed && styles.iconButtonPressed
            ]}
            disabled={ioBusy}
            onPress={() => {
              const filePaths = getUnstageablePaths([item])
              void (filePaths.length > 1
                ? runGitAction(item.unstageActionId, 'git.bulkUnstage', { filePaths })
                : runGitAction(item.unstageActionId, 'git.unstage', { filePath: item.path }))
            }}
            hitSlop={8}
            accessibilityLabel={t('sourceControl.fileRows.unstageFile', 'Unstage {{path}}', {
              path: item.path
            })}
          >
            <Minus size={16} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        ) : item.canStage || item.canDiscard ? (
          <View style={styles.rowActions}>
            {item.canStage ? (
              <Pressable
                style={({ pressed }) => [
                  styles.iconButton,
                  ioBusy && styles.iconButtonDisabled,
                  pressed && styles.iconButtonPressed
                ]}
                disabled={ioBusy}
                onPress={() =>
                  void runGitAction(item.stageActionId, 'git.stage', { filePath: item.path })
                }
                hitSlop={8}
                accessibilityLabel={t('sourceControl.fileRows.stageFile', 'Stage {{path}}', {
                  path: item.path
                })}
              >
                <Plus size={16} color={colors.textSecondary} strokeWidth={2.2} />
              </Pressable>
            ) : null}
            {item.canDiscard ? (
              <Pressable
                style={({ pressed }) => [
                  styles.iconButton,
                  ioBusy && styles.iconButtonDisabled,
                  pressed && styles.iconButtonPressed
                ]}
                disabled={ioBusy}
                onPress={() => setDiscardTarget(item)}
                hitSlop={8}
                accessibilityLabel={t('sourceControl.fileRows.discardFile', 'Discard {{path}}', {
                  path: item.path
                })}
              >
                <Trash2 size={16} color={colors.statusRed} strokeWidth={2.1} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {!rowBusy && item.canOpen ? (
          <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.1} />
        ) : null}
      </Pressable>
    )
  }
}

type BranchState = Pick<
  MobileSourceControlState,
  | 'shouldShowBranchCompareSection'
  | 'branchCompareSummaryText'
  | 'branchEntries'
  | 'branchCompareState'
  | 'branchCompareResult'
  | 'busyAction'
  | 'openBranchDiff'
  | 'openingBranchPath'
  | 'openingPath'
>

export function BranchCompareHeader({ state }: { state: BranchState }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    shouldShowBranchCompareSection,
    branchCompareSummaryText,
    branchEntries,
    branchCompareState,
    branchCompareResult
  } = state
  if (!shouldShowBranchCompareSection) {
    return null
  }

  return (
    <View style={styles.branchCompareBlock}>
      <View style={styles.sectionHeader}>
        <View style={styles.branchSectionTitleBlock}>
          <Text style={styles.sectionTitle}>
            {t('sourceControl.fileRows.committedSection', 'Committed on Branch')}
          </Text>
          {branchCompareSummaryText ? (
            <Text style={styles.branchSectionSubtitle} numberOfLines={1}>
              {branchCompareSummaryText}
            </Text>
          ) : null}
        </View>
        <Text style={styles.sectionCount}>{branchEntries.length}</Text>
      </View>
      {branchCompareState.kind === 'loading' ? (
        <View style={styles.branchStateRow}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.branchStateText}>
            {t('sourceControl.fileRows.loadingCommitted', 'Loading committed changes...')}
          </Text>
        </View>
      ) : branchCompareState.kind === 'error' ? (
        <View style={styles.branchStateRow}>
          <Text style={styles.branchStateText}>{branchCompareState.message}</Text>
        </View>
      ) : branchCompareResult && branchCompareResult.summary.status !== 'ready' ? (
        <View style={styles.branchStateRow}>
          <Text style={styles.branchStateText}>
            {branchCompareResult.summary.errorMessage ??
              t('sourceControl.fileRows.committedUnavailable', 'Committed changes unavailable.')}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

export function BranchFileRow({
  entry,
  state
}: {
  entry: MobileBranchEntryView
  state: BranchState
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { busyAction, openBranchDiff, openingBranchPath, openingPath } = state
  const rowBusy = openingBranchPath === entry.path
  const rowDisabled =
    !entry.canOpen || busyAction !== null || openingPath !== null || openingBranchPath !== null
  const meta = formatMobileBranchEntryMeta(entry)
  return (
    <Pressable
      style={({ pressed }) => [
        styles.fileRow,
        pressed && entry.canOpen && styles.fileRowPressed,
        rowDisabled && styles.fileRowDisabled,
        !entry.canOpen && styles.fileRowUnavailable
      ]}
      onPress={() => void openBranchDiff(entry)}
      disabled={rowDisabled}
      accessibilityLabel={t(
        'sourceControl.fileRows.openCommittedChange',
        'Open committed change {{path}}',
        {
          path: entry.path
        }
      )}
    >
      <View style={styles.statusBadge}>
        <Text style={[styles.statusBadgeText, { color: statusColor(entry.status) }]}>
          {STATUS_LABELS[entry.status]}
        </Text>
      </View>
      <FileText
        size={16}
        color={entry.canOpen ? colors.textSecondary : colors.textMuted}
        strokeWidth={2.1}
      />
      <View style={styles.fileTextBlock}>
        <Text
          style={[styles.filePath, !entry.canOpen && styles.filePathDisabled]}
          numberOfLines={1}
        >
          {entry.path}
        </Text>
        {meta ? (
          <Text style={styles.fileMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {rowBusy ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : entry.canOpen ? (
        <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.1} />
      ) : null}
    </Pressable>
  )
}
