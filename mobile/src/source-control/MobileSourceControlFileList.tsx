import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, SectionList, Text, View } from 'react-native'
import { SectionHeader } from '../components/list/ListGroup'
import { colors } from '../theme/mobile-theme'
import { BranchFileRow, ChangeFileRow, type FileRowState } from './MobileSourceControlFileRows'
import type {
  MobileBranchEntryView,
  MobileGitStatusEntryView
} from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'

type FileEntry = MobileGitStatusEntryView | MobileBranchEntryView
function isWorkingTreeEntry(entry: FileEntry): entry is MobileGitStatusEntryView {
  return typeof entry.stageActionId === 'string'
}

type FileSection = {
  key: string
  title: string
  trailing?: ReactNode
  data: readonly FileEntry[]
}

export type FileListState = FileRowState &
  Pick<
    MobileSourceControlState,
    | 'sections'
    | 'status'
    | 'shouldShowBranchCompareSection'
    | 'branchEntries'
    | 'branchCompareState'
    | 'branchCompareResult'
    | 'stageablePaths'
    | 'unstageablePaths'
    | 'stageAll'
    | 'unstageAll'
  >

export function MobileSourceControlFileList({
  state,
  header,
  bottomInset
}: {
  state: FileListState
  /** The status line, Commits row and conflict banner above the sections. */
  header: ReactNode
  /** Clears the next-step bar the panel floats over the list. */
  bottomInset: number
}) {
  const colorScheme = useMobileColorScheme()
  const t = useMobileTranslation()
  const busy = state.busyAction !== null
  const merging = state.status?.conflictOperation === 'merge'
  // A capped all-staged prefix can hide unstaged rows.
  const canStageAll = state.stageablePaths.length > 0 || state.status?.didHitLimit === true
  const sectionAction = (label: string, onPress: () => void, enabled: boolean) => (
    <Pressable
      onPress={onPress}
      disabled={busy || !enabled}
      hitSlop={8}
      accessibilityRole="button"
      style={({ pressed }) => [
        (busy || !enabled) && styles.iconButtonDisabled,
        pressed && styles.sectionActionPressed
      ]}
    >
      <Text style={styles.sectionAction}>{label}</Text>
    </Pressable>
  )
  // A capped listing can hide every unstaged file behind a staged prefix; keep Stage all reachable.
  const cappedWithoutUnstaged =
    state.status?.didHitLimit === true &&
    !state.sections.some((section) => section.id === 'unstaged')
  const stageAllOnStaged =
    cappedWithoutUnstaged && state.sections.some((section) => section.id === 'staged')
  const stageAllOnConflicts = cappedWithoutUnstaged && !stageAllOnStaged
  const stageAllAction = sectionAction(
    t('sourceControl.fileList.stageAll', 'Stage all'),
    () => void state.stageAll(),
    canStageAll
  )
  const sections: FileSection[] = state.sections.map((section) => {
    const title =
      merging && section.id === 'staged'
        ? t('sourceControl.fileList.mergedCleanly', 'Merged cleanly')
        : section.title
    return {
      key: section.id,
      title: `${title} ${section.data.length}`,
      trailing:
        section.id === 'unstaged' || (section.id === 'conflicts' && stageAllOnConflicts) ? (
          stageAllAction
        ) : section.id === 'staged' ? (
          <View style={styles.sectionActions}>
            {stageAllOnStaged ? stageAllAction : null}
            {merging
              ? null
              : sectionAction(
                  t('sourceControl.fileList.unstageAll', 'Unstage all'),
                  () => void state.unstageAll(),
                  state.unstageablePaths.length > 0
                )}
          </View>
        ) : undefined,
      data: section.data
    }
  })
  const compare = state.branchCompareResult
  if (state.shouldShowBranchCompareSection) {
    const ready = state.branchCompareState.kind === 'ready' && compare?.summary.status === 'ready'
    sections.push({
      key: 'committed',
      title: t('sourceControl.fileList.onThisBranch', 'On this branch {{count}}', {
        count: state.branchEntries.length
      }),
      trailing: compare?.summary.baseRef ? (
        <Text style={styles.sectionMeta}>
          {t('sourceControl.fileList.versusBase', 'vs {{base}}', {
            base: compare.summary.baseRef.replace(/^origin\//, '')
          })}
        </Text>
      ) : undefined,
      data: ready ? state.branchEntries : []
    })
  }
  return (
    <SectionList<FileEntry, FileSection>
      style={hubStyles.tabBody}
      sections={sections}
      extraData={colorScheme}
      ListHeaderComponent={<>{header}</>}
      renderItem={({ item }) =>
        isWorkingTreeEntry(item) ? (
          <ChangeFileRow item={item} state={state} />
        ) : (
          <BranchFileRow entry={item} state={state} />
        )
      }
      keyExtractor={(item) =>
        `${isWorkingTreeEntry(item) ? item.area : 'committed'}:${item.path}:${item.oldPath ?? ''}`
      }
      renderSectionHeader={({ section }) => (
        <View>
          <View style={styles.sectionHeaderBleed}>
            <SectionHeader title={section.title} trailing={section.trailing} />
          </View>
          {section.key === 'committed' ? <BranchCompareState state={state} /> : null}
        </View>
      )}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset }]}
    />
  )
}

// Loading or failure under "On this branch", where its rows would be.
function BranchCompareState({ state }: { state: FileListState }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { branchCompareState, branchCompareResult } = state
  const message =
    branchCompareState.kind === 'error'
      ? branchCompareState.message
      : branchCompareResult && branchCompareResult.summary.status !== 'ready'
        ? (branchCompareResult.summary.errorMessage ??
          t('sourceControl.fileRows.committedUnavailable', 'Committed changes unavailable.'))
        : null
  if (branchCompareState.kind !== 'loading' && message === null) {
    return null
  }
  return (
    <View style={styles.branchStateRow}>
      {branchCompareState.kind === 'loading' ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : null}
      <Text style={styles.branchStateText}>
        {message ?? t('sourceControl.fileRows.loadingCommitted', 'Loading committed changes...')}
      </Text>
    </View>
  )
}
