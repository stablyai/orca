import { useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native'
import type { GitHubPRFile } from '../../../../src/shared/github/pull-request-types'
import type { PRComment } from '../../../../src/shared/github/comment-types'
import type { SourceControlViewMode } from '../../../../src/shared/ui-chrome-types'
import { isPRFileViewed } from '../../../../src/shared/github/pull-request-file-state'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileSegmentedControl } from '../MobileSegmentedControl'
import {
  buildMobilePrFileRows,
  countMobilePrFileFilterMatches,
  countMobilePrFileThreads,
  resolveMobilePrFilesViewMode,
  MOBILE_PR_FILE_FILTERS,
  type MobilePrFileFilter,
  type MobilePrFileRow
} from '../../source-control/mobile-pr-file-rows'
import { PRDirectoryRow, PRFileRow } from './PRFileRow'
import { prFilesStyles as styles } from './pr-files-styles'
import { MobileLoadErrorState } from '../MobileLoadErrorState'

const NO_FILES: GitHubPRFile[] = []

function rowKey(row: MobilePrFileRow): string {
  return row.key
}

export function PRFilesTab({
  files,
  detailsLoaded,
  filesUnavailable,
  comments,
  canMarkViewed,
  pendingViewedPaths,
  viewedError,
  onToggleViewed,
  onOpenFile,
  onRetry,
  bottomInset
}: {
  /** Undefined until details load, or when the details request failed. */
  files: readonly GitHubPRFile[] | undefined
  detailsLoaded: boolean
  filesUnavailable: boolean
  comments: readonly PRComment[]
  canMarkViewed: boolean
  pendingViewedPaths: ReadonlySet<string>
  viewedError: string | null
  onToggleViewed: (path: string, viewed: boolean) => void
  /** Absent where the PR view cannot open a diff, e.g. inside the review screen's drawer. */
  onOpenFile?: (path: string) => void
  onRetry: () => void
  bottomInset: number
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [filters, setFilters] = useState<ReadonlySet<MobilePrFileFilter>>(() => new Set())
  const [chosenMode, setChosenMode] = useState<SourceControlViewMode | null>(null)
  const [directoryExpansion, setDirectoryExpansion] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  )
  const allFiles = files ?? NO_FILES
  const threadCounts = useMemo(() => countMobilePrFileThreads(comments), [comments])
  const viewMode = resolveMobilePrFilesViewMode(chosenMode, allFiles.length)
  const rows = useMemo(
    () =>
      buildMobilePrFileRows({
        files: allFiles,
        threadCounts,
        filters,
        viewMode,
        directoryExpansion
      }),
    [allFiles, directoryExpansion, filters, threadCounts, viewMode]
  )
  const filterCounts = useMemo(
    () => countMobilePrFileFilterMatches(allFiles, threadCounts),
    [allFiles, threadCounts]
  )
  const viewedCount = useMemo(() => allFiles.filter(isPRFileViewed).length, [allFiles])

  const toggleDirectory = useCallback((key: string, expand: boolean) => {
    setDirectoryExpansion((prev) => new Map(prev).set(key, expand))
  }, [])
  const toggleFilter = useCallback((filter: MobilePrFileFilter) => {
    setFilters((prev) => {
      const next = new Set(prev)
      if (!next.delete(filter)) {
        next.add(filter)
      }
      return next
    })
  }, [])

  const renderRow = useCallback(
    ({ item }: { item: MobilePrFileRow }) =>
      item.kind === 'directory' ? (
        <PRDirectoryRow row={item} onToggle={toggleDirectory} />
      ) : (
        <PRFileRow
          row={item}
          showDirectory={viewMode === 'list'}
          canMarkViewed={canMarkViewed}
          pending={pendingViewedPaths.has(item.file.path)}
          onOpen={onOpenFile}
          onToggleViewed={onToggleViewed}
        />
      ),
    [canMarkViewed, onOpenFile, onToggleViewed, pendingViewedPaths, toggleDirectory, viewMode]
  )

  if (!detailsLoaded) {
    return (
      <View style={styles.stateArea}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (files === undefined || (filesUnavailable && files.length === 0)) {
    return (
      <MobileLoadErrorState
        message={t('components.prFiles.unavailable', "Couldn't load changed files.")}
        onRetry={onRetry}
      />
    )
  }
  if (files.length === 0) {
    return (
      <View style={styles.stateArea}>
        <Text style={styles.stateText}>{t('components.prFiles.empty', 'No files changed.')}</Text>
      </View>
    )
  }

  const filterLabel = (filter: MobilePrFileFilter): string => {
    switch (filter) {
      case 'unviewed':
        return t('components.prFiles.filterUnviewed', 'Unviewed')
      case 'commented':
        return t('components.prFiles.filterCommented', 'With comments')
      case 'tests':
        return t('components.prFiles.filterTests', 'Tests')
    }
  }

  const header = (
    <View style={styles.toolbar}>
      <View style={styles.toolbarRow}>
        <Text style={styles.progressText}>
          {t('components.prFiles.viewedProgress', '{{viewed}} of {{total}} viewed', {
            viewed: viewedCount,
            total: files.length
          })}
        </Text>
        <MobileSegmentedControl
          segments={[
            { value: 'tree', label: t('components.prFiles.tree', 'Tree') },
            { value: 'list', label: t('components.prFiles.list', 'List') }
          ]}
          selected={viewMode}
          onSelect={setChosenMode}
          testIDPrefix="pr-files-mode-"
        />
      </View>
      <View style={styles.chips}>
        {MOBILE_PR_FILE_FILTERS.filter(
          (filter) => filters.has(filter) || filterCounts[filter] > 0
        ).map((filter) => {
          const active = filters.has(filter)
          return (
            <Pressable
              key={filter}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              testID={`pr-files-filter-${filter}`}
              onPress={() => toggleFilter(filter)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {filterLabel(filter)} {filterCounts[filter]}
              </Text>
            </Pressable>
          )
        })}
      </View>
      {viewedError ? <Text style={styles.errorText}>{viewedError}</Text> : null}
    </View>
  )

  return (
    <FlatList
      data={rows}
      keyExtractor={rowKey}
      renderItem={renderRow}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <View style={styles.stateArea}>
          <Text style={styles.stateText}>
            {t('components.prFiles.noMatches', 'No files match these filters.')}
          </Text>
        </View>
      }
      contentContainerStyle={{ paddingBottom: bottomInset }}
      initialNumToRender={30}
      windowSize={9}
    />
  )
}
