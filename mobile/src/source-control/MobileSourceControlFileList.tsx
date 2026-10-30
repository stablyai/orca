import { SectionList, Text, View } from 'react-native'
import {
  BranchCompareHeader,
  BranchFileRow,
  makeRenderFileRow
} from './MobileSourceControlFileRows'
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
  | 'resolveConflict'
  | 'runGitAction'
  | 'setDiscardTarget'
>

export function MobileSourceControlFileList({
  state,
  bottomInset
}: {
  state: FileListState
  /** Clears the floating commit bar, which grows with its message. */
  bottomInset: number
}) {
  const colorScheme = useMobileColorScheme()
  const t = useMobileTranslation()
  const sections: FileSection[] = state.sections.map((section) => ({
    ...section,
    key: section.id
  }))
  if (state.shouldShowBranchCompareSection) {
    sections.push({
      key: 'committed',
      title: t('sourceControl.fileList.committedSection', 'Committed on Branch'),
      data:
        state.branchCompareState.kind === 'ready' &&
        state.branchCompareResult?.summary.status === 'ready'
          ? state.branchEntries
          : []
    })
  }
  const renderFileRow = makeRenderFileRow(state, t)
  return (
    <SectionList<FileEntry, FileSection>
      style={hubStyles.tabBody}
      sections={sections}
      extraData={colorScheme}
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
      renderSectionHeader={({ section }) =>
        section.key === 'committed' ? (
          <BranchCompareHeader state={state} />
        ) : (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
          </View>
        )
      }
      stickySectionHeadersEnabled={false}
      contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset }]}
    />
  )
}
