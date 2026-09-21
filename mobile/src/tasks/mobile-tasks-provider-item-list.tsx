import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  View,
  ActivityIndicator,
  colors,
  Text,
  FlatList,
  spacing,
  Pressable,
  ChevronLeft,
  ChevronRight,
  triggerMediumImpact,
  Linking,
  TaskProviderLogo,
  GitBranch,
  getHostedReviewSignalTone,
  getHostedReviewLabel,
  getHostedChecksLabel,
  getHostedMergeLabel
} from './mobile-tasks-dependencies'
import { styles, getPrSignalToneStyle } from './mobile-tasks-legacy-styles'
import {
  taskRepositoryMeta,
  formatGitHubPRDelta,
  hostedBranchSummary,
  formatUpdatedAt,
  taskKindLabel,
  getGitHubReviewSummary,
  getGitHubMergeLabel
} from './mobile-tasks-legacy-foundation'

export function renderMobileTasksProviderItemList(model: ConnectionPresentationModel) {
  const {
    displayedEntries,
    emptyLabel,
    githubCanLoadUncountedNextPage,
    githubCanShowPagination,
    githubCurrentPage,
    githubLoadingTargetPage,
    githubMode,
    githubPaginationLoading,
    githubTotalCount,
    githubTotalPages,
    handleGitHubPageChange,
    insets,
    loading,
    provider,
    refreshTasks,
    refreshing,
    reposById,
    setActionItem,
    setShowGitHubPagePicker,
    sortedItems,
    taskUiReady
  } = model
  return loading ? (
    <View style={styles.centered}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : sortedItems.length === 0 ? (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>{emptyLabel}</Text>
    </View>
  ) : (
    <FlatList
      data={displayedEntries}
      keyExtractor={(entry) => entry.key}
      ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
        leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
          <View style={styles.separator} />
        )
      }
      contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
      refreshing={refreshing}
      onRefresh={refreshTasks}
      ListFooterComponent={
        provider === 'github' && githubMode === 'items' && githubCanShowPagination ? (
          <View style={styles.paginationFooter}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous page"
              accessibilityState={{
                disabled: githubCurrentPage === 0 || githubPaginationLoading
              }}
              style={[
                styles.paginationButton,
                (githubCurrentPage === 0 || githubPaginationLoading) &&
                  styles.paginationButtonDisabled
              ]}
              disabled={githubCurrentPage === 0 || githubPaginationLoading}
              onPress={() => void handleGitHubPageChange(githubCurrentPage - 1)}
            >
              <ChevronLeft size={17} color={colors.textPrimary} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                githubTotalCount === null
                  ? `Select page, Page ${githubCurrentPage + 1}`
                  : `Select page, Page ${githubCurrentPage + 1} of ${githubTotalPages}`
              }
              accessibilityState={{ disabled: githubPaginationLoading }}
              style={styles.paginationLabelButton}
              disabled={githubPaginationLoading}
              onPress={() => {
                if (!taskUiReady) {
                  return
                }
                setShowGitHubPagePicker(true)
              }}
            >
              <Text style={styles.paginationLabel}>
                {githubTotalCount === null
                  ? `Page ${githubCurrentPage + 1}`
                  : `Page ${githubCurrentPage + 1} of ${githubTotalPages}`}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next page"
              accessibilityState={{
                disabled:
                  (!githubCanLoadUncountedNextPage && githubCurrentPage >= githubTotalPages - 1) ||
                  githubPaginationLoading
              }}
              style={[
                styles.paginationButton,
                ((!githubCanLoadUncountedNextPage && githubCurrentPage >= githubTotalPages - 1) ||
                  githubPaginationLoading) &&
                  styles.paginationButtonDisabled
              ]}
              disabled={
                (!githubCanLoadUncountedNextPage && githubCurrentPage >= githubTotalPages - 1) ||
                githubPaginationLoading
              }
              onPress={() => void handleGitHubPageChange(githubCurrentPage + 1)}
            >
              {githubLoadingTargetPage === githubCurrentPage + 1 ? (
                <ActivityIndicator size="small" color={colors.textPrimary} />
              ) : (
                <ChevronRight size={17} color={colors.textPrimary} />
              )}
            </Pressable>
          </View>
        ) : null
      }
      renderItem={({ item: entry }) => {
        if (entry.type === 'section') {
          return (
            <View style={styles.repoSectionHeader}>
              <View style={[styles.repoSectionDot, { backgroundColor: entry.color }]} />
              <Text style={styles.repoSectionTitle} numberOfLines={1}>
                {entry.label}
              </Text>
            </View>
          )
        }
        const item = entry.item
        const repo = taskRepositoryMeta(item, reposById)
        const isGitHubPr = item.provider === 'github' && item.source.type === 'pr'
        const isGitLabMr = item.provider === 'gitlab' && item.source.type === 'mr'
        const githubPrDelta = isGitHubPr ? formatGitHubPRDelta(item.source) : null
        const branchSummary = hostedBranchSummary(item)
        return (
          <Pressable
            style={({ pressed }) => [styles.taskRow, pressed && styles.taskRowPressed]}
            onPress={() => {
              triggerMediumImpact()
              if (item.provider === 'gitlabTodo') {
                void Linking.openURL(item.source.targetUrl)
                return
              }
              setActionItem(item)
            }}
          >
            <View style={styles.taskIcon}>
              <TaskProviderLogo
                provider={item.provider === 'gitlabTodo' ? 'gitlab' : item.provider}
                size={15}
                color={colors.textSecondary}
              />
            </View>
            <View style={styles.taskMain}>
              <View style={styles.taskTitleRow}>
                <Text style={styles.taskTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.updatedAt}>{formatUpdatedAt(item.updatedAt)}</Text>
              </View>
              <View style={styles.metaRow}>
                <View style={[styles.repoDot, { backgroundColor: repo.color }]} />
                <Text style={styles.subtitle} numberOfLines={1}>
                  {taskKindLabel(item)} · {item.subtitle}
                </Text>
              </View>
              {branchSummary ? (
                <View style={styles.branchMetaRow}>
                  <GitBranch size={11} color={colors.textMuted} />
                  <Text style={styles.branchMetaText} numberOfLines={1}>
                    {branchSummary.head}
                  </Text>
                  <Text style={styles.branchMetaBase} numberOfLines={1}>
                    into {branchSummary.base}
                  </Text>
                </View>
              ) : null}
              {isGitHubPr || isGitLabMr ? (
                <View style={styles.prSignalRow}>
                  {isGitHubPr && githubPrDelta ? (
                    <View style={styles.prSignalChip}>
                      <Text style={styles.prSignalText} numberOfLines={1}>
                        {githubPrDelta}
                      </Text>
                    </View>
                  ) : null}
                  {isGitHubPr || isGitLabMr ? (
                    <View
                      style={[
                        styles.prSignalChip,
                        getPrSignalToneStyle(getHostedReviewSignalTone(item.source, 'review'))
                      ]}
                    >
                      <Text style={styles.prSignalText} numberOfLines={1}>
                        {isGitHubPr
                          ? getGitHubReviewSummary(item.source)
                          : getHostedReviewLabel(item.source)}
                      </Text>
                    </View>
                  ) : null}
                  <View
                    style={[
                      styles.prSignalChip,
                      getPrSignalToneStyle(getHostedReviewSignalTone(item.source, 'checks'))
                    ]}
                  >
                    <Text style={styles.prSignalText} numberOfLines={1}>
                      {getHostedChecksLabel(item.source)}
                    </Text>
                  </View>
                  {isGitHubPr || isGitLabMr ? (
                    <View
                      style={[
                        styles.prSignalChip,
                        getPrSignalToneStyle(getHostedReviewSignalTone(item.source, 'merge'))
                      ]}
                    >
                      <Text style={styles.prSignalText} numberOfLines={1}>
                        {isGitHubPr
                          ? getGitHubMergeLabel(item.source)
                          : getHostedMergeLabel(item.source)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
            <View style={styles.taskRowTrailing}>
              <View style={styles.statusPill}>
                <Text style={styles.statusText} numberOfLines={1}>
                  {item.status}
                </Text>
              </View>
            </View>
          </Pressable>
        )
      }}
    />
  )
}
