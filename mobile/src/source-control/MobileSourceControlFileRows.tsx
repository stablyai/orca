import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { FileText, Minus, Plus, Trash2 } from 'lucide-react-native'
import type { SectionListRenderItem } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { MOBILE_GIT_STATUS_LABELS, type MobileSourceControlSection } from './mobile-git-status'
import { formatMobileBranchEntryMeta } from './mobile-branch-entry-format'
import { statusColor, type MobileGitStatusEntryView } from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
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

export function makeRenderFileRow(
  state: RowState
): SectionListRenderItem<
  MobileGitStatusEntryView,
  MobileSourceControlSection<MobileGitStatusEntryView>
> {
  const { busyAction, openingPath, openingBranchPath, openFile, runGitAction, setDiscardTarget } =
    state
  return function FileRow({ item }) {
    const rowBusy =
      busyAction === item.stageActionId ||
      busyAction === item.unstageActionId ||
      busyAction === item.discardActionId ||
      openingPath === item.path
    const rowDisabled =
      !item.canOpen || busyAction !== null || openingPath !== null || openingBranchPath !== null
    const ioBusy = busyAction !== null || openingPath !== null || openingBranchPath !== null
    return (
      <Pressable
        style={({ pressed }) => [
          styles.fileRow,
          pressed && item.canOpen && styles.fileRowPressed,
          rowDisabled && styles.fileRowDisabled,
          !item.canOpen && styles.fileRowUnavailable
        ]}
        onPress={() => void openFile(item)}
        disabled={rowDisabled}
        accessibilityLabel={`Open changed file ${item.path}`}
      >
        <View style={styles.statusBadge}>
          <Text style={[styles.statusBadgeText, { color: statusColor(item.status) }]}>
            {MOBILE_GIT_STATUS_LABELS[item.status]}
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
              from {item.oldPath}
            </Text>
          ) : item.conflictStatus === 'unresolved' ? (
            <Text style={styles.fileMeta} numberOfLines={1}>
              Unresolved conflict
            </Text>
          ) : null}
        </View>
        {rowBusy ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : item.area === 'staged' ? (
          <Pressable
            style={({ pressed }) => [
              styles.iconButton,
              ioBusy && styles.iconButtonDisabled,
              pressed && styles.iconButtonPressed
            ]}
            disabled={ioBusy}
            onPress={() =>
              void runGitAction(item.unstageActionId, 'git.unstage', { filePath: item.path })
            }
            hitSlop={8}
            accessibilityLabel={`Unstage ${item.path}`}
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
                accessibilityLabel={`Stage ${item.path}`}
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
                accessibilityLabel={`Discard ${item.path}`}
              >
                <Trash2 size={16} color={colors.statusRed} strokeWidth={2.1} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    )
  }
}

type FooterState = Pick<
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

export function BranchCompareFooter({ state }: { state: FooterState }) {
  const {
    shouldShowBranchCompareSection,
    branchCompareSummaryText,
    branchEntries,
    branchCompareState,
    branchCompareResult,
    busyAction,
    openBranchDiff,
    openingBranchPath,
    openingPath
  } = state
  if (!shouldShowBranchCompareSection) {
    return null
  }

  return (
    <View style={styles.branchCompareBlock}>
      <View style={styles.sectionHeader}>
        <View style={styles.branchSectionTitleBlock}>
          <Text style={styles.sectionTitle}>Committed on Branch</Text>
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
          <Text style={styles.branchStateText}>Loading committed changes...</Text>
        </View>
      ) : branchCompareState.kind === 'error' ? (
        <View style={styles.branchStateRow}>
          <Text style={styles.branchStateText}>{branchCompareState.message}</Text>
        </View>
      ) : branchCompareResult && branchCompareResult.summary.status !== 'ready' ? (
        <View style={styles.branchStateRow}>
          <Text style={styles.branchStateText}>
            {branchCompareResult.summary.errorMessage ?? 'Committed changes unavailable.'}
          </Text>
        </View>
      ) : (
        branchEntries.map((entry) => {
          const rowBusy = openingBranchPath === entry.path
          const rowDisabled =
            !entry.canOpen ||
            busyAction !== null ||
            openingPath !== null ||
            openingBranchPath !== null
          const meta = formatMobileBranchEntryMeta(entry)
          return (
            <Pressable
              key={`${entry.path}:${entry.oldPath ?? ''}`}
              style={({ pressed }) => [
                styles.fileRow,
                pressed && entry.canOpen && styles.fileRowPressed,
                rowDisabled && styles.fileRowDisabled,
                !entry.canOpen && styles.fileRowUnavailable
              ]}
              onPress={() => void openBranchDiff(entry)}
              disabled={rowDisabled}
              accessibilityLabel={`Open committed change ${entry.path}`}
            >
              <View style={styles.statusBadge}>
                <Text style={[styles.statusBadgeText, { color: statusColor(entry.status) }]}>
                  {MOBILE_GIT_STATUS_LABELS[entry.status]}
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
              {rowBusy ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
            </Pressable>
          )
        })
      )}
    </View>
  )
}
