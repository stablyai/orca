import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { translate } from '../../i18n/mobile-i18n'
import { View, ActivityIndicator, FlatList } from 'react-native'
import { colors, spacing, type MobileColorScheme } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { openExternalLink } from '../../platform/external-links/external-link'
import { SectionHeader } from '../../components/list/ListGroup'
import { ignoreKeptRowPress, renderMobileTasksListState } from './mobile-tasks-list-state'
import { MobileTaskRow, MobileTaskRowSeparator } from './mobile-task-row'
import type { TaskListEntry } from '../mobile-tasks-project-workspace-types'

// Names what the list holds, since the controls that chose it sit in the filter sheet.
function listHeading(model: ConnectionPresentationModel): string {
  if (model.hasSearch) {
    return translate('tasks.providerItemList.results', 'Results')
  }
  if (model.provider === 'github') {
    switch (model.githubPreset) {
      case 'my-issues':
        return translate('tasks.providerItemList.assignedToYou', 'Assigned to you')
      case 'prs':
        return translate('tasks.providerItemList.openPullRequests', 'Open pull requests')
      case 'my-prs':
        return translate('tasks.providerItemList.yourPullRequests', 'Your pull requests')
      case 'review':
        return translate('tasks.providerItemList.needsYourReview', 'Needs your review')
      case 'issues':
        return translate('tasks.providerItemList.openIssues', 'Open issues')
    }
  }
  if (model.provider === 'jira') {
    return model.jiraFilterLabel
  }
  return model.gitlabView === 'todos'
    ? translate('tasks.providerItemList.todos', 'To-dos')
    : model.gitlabFilterLabel
}

function isEdge(entry: TaskListEntry | undefined): boolean {
  return entry === undefined || entry.type === 'section'
}

export function renderMobileTasksProviderItemList(
  model: ConnectionPresentationModel,
  colorScheme: MobileColorScheme,
  bottomBarHeight: number
) {
  const {
    displayedEntries,
    githubCanLoadUncountedNextPage,
    githubCanShowPagination,
    githubMode,
    githubPages,
    githubPaginationLoading,
    githubTotalPages,
    handleGitHubPageChange,
    insets,
    provider,
    refreshTasks,
    refreshing,
    sortedItems,
    taskUiReady
  } = model
  // The last list, kept before Tasks is ready, is read-only.
  const setActionItem = taskUiReady ? model.setActionItem : ignoreKeptRowPress
  const listState = renderMobileTasksListState(model, sortedItems.length, bottomBarHeight)
  if (listState) {
    return listState
  }
  const canLoadMore =
    provider === 'github' &&
    githubMode === 'items' &&
    githubCanShowPagination &&
    (githubPages.length < githubTotalPages || githubCanLoadUncountedNextPage)
  const sectioned = displayedEntries[0]?.type === 'section'
  return (
    <FlatList
      data={displayedEntries}
      extraData={colorScheme}
      keyExtractor={(entry) => entry.key}
      ItemSeparatorComponent={({ leadingItem, trailingItem }) =>
        leadingItem?.type === 'section' || trailingItem?.type === 'section' ? null : (
          <MobileTaskRowSeparator />
        )
      }
      contentContainerStyle={{
        paddingBottom: spacing.lg + Math.max(insets.bottom, bottomBarHeight)
      }}
      ListHeaderComponent={
        sectioned ? undefined : (
          <View style={styles.heading}>
            <SectionHeader title={listHeading(model)} first />
          </View>
        )
      }
      refreshing={refreshing}
      onRefresh={refreshTasks}
      onEndReached={canLoadMore ? () => void handleGitHubPageChange(githubPages.length) : undefined}
      onEndReachedThreshold={0.5}
      ListFooterComponent={
        githubPaginationLoading ? (
          <View style={styles.footer}>
            <ActivityIndicator size="small" color={colors.textMuted} />
          </View>
        ) : undefined
      }
      renderItem={({ item: entry, index }) => {
        if (entry.type === 'section') {
          return (
            <View style={styles.heading}>
              <SectionHeader title={entry.label} first={index === 0} />
            </View>
          )
        }
        const item = entry.item
        return (
          <MobileTaskRow
            item={item}
            first={isEdge(displayedEntries[index - 1])}
            last={isEdge(displayedEntries[index + 1])}
            onPress={() => {
              if (item.provider === 'gitlabTodo') {
                void openExternalLink(item.source.targetUrl)
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

const styles = themedStyleSheet(() => ({
  heading: { marginHorizontal: spacing.lg },
  footer: { paddingVertical: spacing.lg, alignItems: 'center' }
}))
