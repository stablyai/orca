import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, Minus, Plus, Trash2 } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { IconButton } from '../components/ui/IconButton'
import { Button } from '../components/ui/Button'
import { SectionHeader } from '../components/ui/SectionHeader'
import { MOBILE_GIT_STATUS_LABELS } from './mobile-git-status'
import { formatMobileBranchEntryMeta } from './mobile-branch-entry-format'
import { splitMobileFilePath } from './mobile-file-path-parts'
import {
  statusColor,
  type MobileBranchEntryView,
  type MobileGitStatusEntryView
} from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import type { MobileGitFileStatus } from './mobile-git-status'
import { styles } from './mobile-source-control-styles'

type RowState = Pick<
  MobileSourceControlState,
  | 'busyAction'
  | 'openingPath'
  | 'openingBranchPath'
  | 'openFile'
  | 'runGitAction'
  | 'setDiscardTarget'
>

type FileRowShellProps = {
  path: string
  status: MobileGitFileStatus
  meta: string | null
  metaWarning?: boolean
  canOpen: boolean
  disabled: boolean
  busy: boolean
  actions?: ReactNode
  onPress: () => void
  accessibilityLabel: string
}

function FileRowShell({
  path,
  status,
  meta,
  metaWarning = false,
  canOpen,
  disabled,
  busy,
  actions,
  onPress,
  accessibilityLabel
}: FileRowShellProps) {
  const { name, directory } = splitMobileFilePath(path)
  const detail = [directory, meta].filter(Boolean).join(' · ')
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, busy }}
    >
      {({ pressed }) => (
        <View style={[styles.fileRow, pressed && canOpen && styles.fileRowPressed]}>
          <View style={styles.statusSlot}>
            <Text style={[styles.statusLetter, { color: statusColor(status) }]}>
              {MOBILE_GIT_STATUS_LABELS[status]}
            </Text>
          </View>
          <View style={styles.fileTextBlock}>
            <Text
              style={[styles.fileName, !canOpen && styles.fileNameUnavailable]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {name}
            </Text>
            {detail ? (
              <Text
                style={[styles.fileDetail, metaWarning && styles.fileDetailWarning]}
                numberOfLines={1}
                ellipsizeMode="head"
              >
                {detail}
              </Text>
            ) : null}
          </View>
          {busy ? (
            <View style={styles.rowSpinner}>
              <ActivityIndicator size="small" color={colors.textSecondary} />
            </View>
          ) : (
            actions
          )}
          {!busy && canOpen ? (
            <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
          ) : null}
        </View>
      )}
    </Pressable>
  )
}

export function makeRenderFileRow(state: RowState) {
  const { busyAction, openingPath, openingBranchPath, openFile, runGitAction, setDiscardTarget } =
    state
  return function FileRow({ item }: { item: MobileGitStatusEntryView }) {
    const rowBusy =
      busyAction === item.stageActionId ||
      busyAction === item.unstageActionId ||
      busyAction === item.discardActionId ||
      openingPath === item.path
    const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null
    const rowDisabled = !item.canOpen || ioBusy
    const actions =
      item.area === 'staged' ? (
        <IconButton
          icon={Minus}
          variant="bare"
          iconSize={18}
          iconColor={colors.textSecondary}
          disabled={ioBusy}
          onPress={() =>
            void runGitAction(item.unstageActionId, 'git.unstage', { filePath: item.path })
          }
          accessibilityLabel={`Unstage ${item.path}`}
        />
      ) : item.canStage || item.canDiscard ? (
        <View style={styles.rowActions}>
          {item.canDiscard ? (
            <IconButton
              icon={Trash2}
              variant="bare"
              iconSize={17}
              iconColor={colors.textSecondary}
              disabled={ioBusy}
              onPress={() => setDiscardTarget(item)}
              accessibilityLabel={`Discard ${item.path}`}
            />
          ) : null}
          {item.canStage ? (
            <IconButton
              icon={Plus}
              variant="bare"
              iconSize={18}
              iconColor={colors.textSecondary}
              disabled={ioBusy}
              onPress={() =>
                void runGitAction(item.stageActionId, 'git.stage', { filePath: item.path })
              }
              accessibilityLabel={`Stage ${item.path}`}
            />
          ) : null}
        </View>
      ) : null
    return (
      <FileRowShell
        path={item.path}
        status={item.status}
        meta={
          item.oldPath
            ? `from ${item.oldPath}`
            : item.conflictStatus === 'unresolved'
              ? 'Unresolved conflict'
              : null
        }
        metaWarning={!item.oldPath && item.conflictStatus === 'unresolved'}
        canOpen={item.canOpen}
        disabled={rowDisabled}
        busy={rowBusy}
        actions={actions}
        onPress={() => void openFile(item)}
        accessibilityLabel={`Open changed file ${item.path}`}
      />
    )
  }
}

type SectionActionState = Pick<
  MobileSourceControlState,
  'busyAction' | 'openingPath' | 'openingBranchPath' | 'stageAll' | 'unstageAll'
> & { canStageAll: boolean; canUnstageAll: boolean }

/** A working-tree section's header, carrying Stage all or Unstage all where they apply. */
export function ChangesSectionHeader({
  title,
  count,
  showStageAll,
  showUnstageAll,
  first,
  state
}: {
  title: string
  count: number
  showStageAll: boolean
  showUnstageAll: boolean
  first: boolean
  state: SectionActionState
}) {
  const ioBusy =
    state.busyAction !== null || state.openingPath !== null || state.openingBranchPath !== null
  return (
    <SectionHeader
      title={title}
      count={count}
      first={first}
      action={
        <View style={styles.sectionActions}>
          {showUnstageAll ? (
            <Button
              label="Unstage all"
              variant="plain"
              size="compact"
              busy={state.busyAction === 'unstage-all'}
              disabled={ioBusy || !state.canUnstageAll}
              onPress={() => void state.unstageAll()}
            />
          ) : null}
          {showStageAll ? (
            <Button
              label="Stage all"
              variant="plain"
              size="compact"
              busy={state.busyAction === 'stage-all'}
              disabled={ioBusy || !state.canStageAll}
              onPress={() => void state.stageAll()}
            />
          ) : null}
        </View>
      }
    />
  )
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

export function BranchCompareHeader({
  state,
  first = false
}: {
  state: BranchState
  first?: boolean
}) {
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
  const notice =
    branchCompareState.kind === 'error'
      ? branchCompareState.message
      : branchCompareResult && branchCompareResult.summary.status !== 'ready'
        ? (branchCompareResult.summary.errorMessage ?? 'Committed changes are unavailable.')
        : null

  return (
    <View>
      <SectionHeader title="Committed on branch" count={branchEntries.length} first={first} />
      {branchCompareSummaryText ? (
        <Text style={styles.sectionSubtitle} numberOfLines={1}>
          {branchCompareSummaryText}
        </Text>
      ) : null}
      {branchCompareState.kind === 'loading' ? (
        <View style={styles.branchStateRow}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.branchStateText}>Loading committed changes…</Text>
        </View>
      ) : notice ? (
        <View style={styles.branchStateRow}>
          <Text style={styles.branchStateText}>{notice}</Text>
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
  const { busyAction, openBranchDiff, openingBranchPath, openingPath } = state
  const rowDisabled =
    !entry.canOpen || busyAction !== null || openingPath !== null || openingBranchPath !== null
  return (
    <FileRowShell
      path={entry.path}
      status={entry.status}
      meta={formatMobileBranchEntryMeta(entry)}
      canOpen={entry.canOpen}
      disabled={rowDisabled}
      busy={openingBranchPath === entry.path}
      onPress={() => void openBranchDiff(entry)}
      accessibilityLabel={`Open committed change ${entry.path}`}
    />
  )
}
