import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import {
  View,
  FlatList,
  spacing,
  ChevronLeft,
  ChevronRight,
  Linking,
  Inbox,
  SearchX,
  getHostedReviewSignalTone,
  getHostedReviewLabel,
  getHostedChecksLabel,
  getHostedMergeLabel
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  taskRepositoryMeta,
  formatUpdatedAt,
  getGitHubReviewSummary,
  getGitHubMergeLabel,
  type TaskItem
} from './mobile-tasks-legacy-foundation'
import { MobileTaskRow, type TaskRowBadge } from './mobile-tasks-task-row'
import { signalBadgeTone, taskStatusGlyph } from './mobile-tasks-status-glyph'
import { renderMobileTasksChrome } from './mobile-tasks-screen-chrome'
import { renderMobileTasksStatePage } from './mobile-tasks-list-surface'
import { clearMobileTasksSearch } from './mobile-tasks-search-control'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { SectionHeader } from '../components/ui/SectionHeader'
import { StateView } from '../components/ui/StateView'

/** At most two signals for an open PR or MR: checks, then conflicts or the review state. */
export function taskRowReviewBadges(item: TaskItem): TaskRowBadge[] {
  if (item.provider !== 'github' && item.provider !== 'gitlab') {
    return []
  }
  if (item.provider === 'github' ? item.source.type !== 'pr' : item.source.type !== 'mr') {
    return []
  }
  const state = item.source.state
  if (state === 'merged' || state === 'closed' || state === 'locked') {
    return []
  }
  const source = item.source
  const badges: TaskRowBadge[] = []
  if (source.checksSummary) {
    badges.push({
      key: 'checks',
      label: getHostedChecksLabel(source),
      tone: signalBadgeTone(getHostedReviewSignalTone(source, 'checks'))
    })
  }
  const mergeTone = getHostedReviewSignalTone(source, 'merge')
  if (mergeTone === 'danger') {
    badges.push({
      key: 'merge',
      label:
        item.provider === 'github' ? getGitHubMergeLabel(item.source) : getHostedMergeLabel(source),
      tone: 'red'
    })
  } else {
    const reviewTone = getHostedReviewSignalTone(source, 'review')
    if (reviewTone !== 'neutral') {
      badges.push({
        key: 'review',
        label:
          item.provider === 'github'
            ? getGitHubReviewSummary(item.source)
            : getHostedReviewLabel(source),
        tone: signalBadgeTone(reviewTone)
      })
    }
  }
  return badges.slice(0, 2)
}

/** The row's one grey line: where it lives, its number, and (once) how fresh it is. */
function taskRowMeta(item: TaskItem): string {
  const lead =
    item.provider === 'gitlabTodo'
      ? `${item.status} · ${item.subtitle}`
      : item.provider === 'jira'
        ? `${item.subtitle} · ${item.status}`
        : item.subtitle
  return [lead, formatUpdatedAt(item.updatedAt)].filter(Boolean).join(' · ')
}

export function renderMobileTasksProviderItemList(model: PageChromeModel) {
  const {
    displayedEntries,
    emptyLabel,
    githubCanLoadUncountedNextPage,
    githubCanShowPagination,
    githubCurrentPage,
    githubMode,
    githubPaginationLoading,
    githubCountedTotalPages,
    githubTotalPages,
    handleGitHubPageChange,
    hasUserQuery,
    insets,
    loading,
    onPageScroll,
    provider,
    reposById,
    setActionItem,
    setShowGitHubPagePicker,
    sortedItems,
    taskUiReady
  } = model
  if (loading) {
    return renderMobileTasksStatePage(model, <StateView loading title="Loading tasks…" />)
  }
  if (sortedItems.length === 0) {
    return renderMobileTasksStatePage(
      model,
      hasUserQuery ? (
        <StateView
          icon={SearchX}
          title={emptyLabel}
          message="Try different words, or clear the search."
          secondary={{
            label: 'Clear search',
            onPress: () => clearMobileTasksSearch(model)
          }}
        />
      ) : (
        <StateView
          icon={Inbox}
          title={emptyLabel}
          message="Nothing matches this view right now. Try another filter or repository."
        />
      )
    )
  }
  const atLastPage = !githubCanLoadUncountedNextPage && githubCurrentPage >= githubTotalPages - 1
  const pageLabel =
    githubCountedTotalPages === null
      ? `Page ${githubCurrentPage + 1}`
      : `Page ${githubCurrentPage + 1} of ${githubTotalPages}`
  return (
    <FlatList
      style={styles.page}
      data={displayedEntries}
      keyExtractor={(entry) => entry.key}
      ListHeaderComponent={renderMobileTasksChrome(model)}
      onScroll={onPageScroll}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
        leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
          <View style={styles.separator} />
        )
      }
      contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
      ListFooterComponent={
        provider === 'github' && githubMode === 'items' && githubCanShowPagination ? (
          <View style={styles.paginationFooter}>
            <IconButton
              icon={ChevronLeft}
              accessibilityLabel="Previous page"
              disabled={githubCurrentPage === 0 || githubPaginationLoading}
              onPress={() => void handleGitHubPageChange(githubCurrentPage - 1)}
            />
            <Button
              label={pageLabel}
              size="compact"
              busy={githubPaginationLoading}
              accessibilityLabel={`Select page, ${pageLabel}`}
              onPress={() => {
                if (taskUiReady) {
                  setShowGitHubPagePicker(true)
                }
              }}
            />
            <IconButton
              icon={ChevronRight}
              accessibilityLabel="Next page"
              disabled={atLastPage || githubPaginationLoading}
              onPress={() => void handleGitHubPageChange(githubCurrentPage + 1)}
            />
          </View>
        ) : null
      }
      renderItem={({ item: entry }) => {
        if (entry.type === 'section') {
          return <SectionHeader title={entry.label} />
        }
        const item = entry.item
        return (
          <MobileTaskRow
            title={item.title}
            meta={taskRowMeta(item)}
            metaDotColor={
              item.provider === 'github' || item.provider === 'gitlab'
                ? taskRepositoryMeta(item, reposById).color
                : undefined
            }
            status={taskStatusGlyph(item)}
            badges={taskRowReviewBadges(item)}
            opensExternally={item.provider === 'gitlabTodo'}
            onPress={() => {
              if (item.provider === 'gitlabTodo') {
                void Linking.openURL(item.source.targetUrl)
                return
              }
              setActionItem(item)
            }}
          />
        )
      }}
    />
  )
}
