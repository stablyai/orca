import { SectionList, View } from 'react-native'
import {
  BranchCompareHeader,
  BranchFileRow,
  ChangesSectionHeader,
  makeRenderFileRow
} from './MobileSourceControlFileRows'
import type {
  MobileBranchEntryView,
  MobileGitStatusEntryView
} from './mobile-source-control-screen-state'
import type { MobileSourceControlState } from './use-mobile-source-control-state'
import { styles } from './mobile-source-control-styles'
import { hubStyles } from './mobile-source-control-hub-styles'

type FileEntry = MobileGitStatusEntryView | MobileBranchEntryView
function isWorkingTreeEntry(entry: FileEntry): entry is MobileGitStatusEntryView {
  return typeof entry.stageActionId === 'string'
}

type FileSection = { key: string; title: string; data: readonly FileEntry[] }

export type FileListState = Pick<
  MobileSourceControlState,
  | 'sections'
  | 'shouldShowBranchCompareSection'
  | 'branchCompareSummaryText'
  | 'branchEntries'
  | 'branchCompareState'
  | 'branchCompareResult'
  | 'busyAction'
  | 'openingPath'
  | 'openingBranchPath'
  | 'openFile'
  | 'openBranchDiff'
  | 'runGitAction'
  | 'setDiscardTarget'
  | 'stageAll'
  | 'unstageAll'
> & {
  canStageAll: boolean
  canUnstageAll: boolean
  /** Room under the last row for the commit bar floating over the list. */
  bottomInset: number
}

export function MobileSourceControlFileList({ state }: { state: FileListState }) {
  const sections: FileSection[] = state.sections.map((section) => ({
    ...section,
    key: section.area
  }))
  if (state.shouldShowBranchCompareSection) {
    sections.push({
      key: 'committed',
      title: 'Committed on branch',
      data:
        state.branchCompareState.kind === 'ready' &&
        state.branchCompareResult?.summary.status === 'ready'
          ? state.branchEntries
          : []
    })
  }
  // Stage all sits on the first unstaged section; a capped listing may hide those, so fall back.
  const stageAllKey =
    sections.find((section) => section.key !== 'staged' && section.key !== 'committed')?.key ??
    (state.canStageAll ? 'staged' : null)
  const renderFileRow = makeRenderFileRow(state)
  return (
    <SectionList<FileEntry, FileSection>
      style={hubStyles.tabBody}
      sections={sections}
      renderItem={({ item }) =>
        isWorkingTreeEntry(item) ? (
          renderFileRow({ item })
        ) : (
          <BranchFileRow entry={item} state={state} />
        )
      }
      keyExtractor={(item) =>
        `${isWorkingTreeEntry(item) ? item.area : 'committed'}:${item.path}:${item.oldPath ?? ''}`
      }
      ItemSeparatorComponent={RowSeparator}
      renderSectionHeader={({ section }) => {
        // The branch block sits above the list, so even the first section keeps its full top space.
        const first = false
        return section.key === 'committed' ? (
          <BranchCompareHeader state={state} first={first} />
        ) : (
          <ChangesSectionHeader
            title={section.title}
            count={section.data.length}
            showStageAll={section.key === stageAllKey}
            showUnstageAll={section.key === 'staged'}
            first={first}
            state={state}
          />
        )
      }}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ paddingBottom: state.bottomInset }}
    />
  )
}

function RowSeparator() {
  return <View style={styles.rowSeparator} />
}
