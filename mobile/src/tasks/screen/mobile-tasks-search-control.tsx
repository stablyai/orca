import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { Plus, SlidersHorizontal } from 'lucide-react-native'
import { getTaskPresetQuery } from '../../../../src/shared/work-items/task-preset-query'
import {
  getDefaultPresetForGitHubTaskKind,
  getGitHubTaskKind,
  scopeGitHubTaskSearch
} from '../../../../src/shared/work-items/task-github-search'
import { BottomSearchBar } from '../../components/nav-bar/BottomSearchBar'
import { mobileTasksFilterCount } from './mobile-tasks-filter-selection'
import { githubQueryFromSearchField, githubSearchFieldText } from './github-task-search-field'

function searchPlaceholder(model: ConnectionPresentationModel): string {
  const { t } = model
  if (model.isGithubProjectSearch) {
    return t('tasks.searchControl.viewPlaceholder', 'Search this view')
  }
  if (model.provider === 'github') {
    return model.githubKind === 'prs'
      ? t('tasks.searchControl.pullRequestsPlaceholder', 'Search pull requests')
      : t('tasks.searchControl.issuesPlaceholder', 'Search issues')
  }
  return t('tasks.searchControl.sourcePlaceholder', 'Search {{provider}}', {
    provider: model.providerLabel
  })
}

/** GitLab todos and unconnected sources have nothing to search; the bar stays for its filter button. */
function mobileTasksSearchable(model: ConnectionPresentationModel): boolean {
  const { gitlabView, jiraConnection, linearConnected, provider } = model
  return !(
    (provider === 'gitlab' && gitlabView === 'todos') ||
    (provider === 'linear' && !linearConnected) ||
    (provider === 'jira' && !jiraConnection.connected)
  )
}

// Filter, search and New issue sit at the bottom; the list pads by the height it covers.
export function renderMobileTasksSearchControl(
  model: ConnectionPresentationModel,
  onCoveredHeightChange: (height: number) => void
) {
  const {
    appliedGithubProjectSearch,
    applyGitHubProjectSearch,
    githubKind,
    githubPreset,
    githubProjectSearch,
    insets,
    isGithubProjectSearch,
    persistTaskResumeState,
    provider,
    query,
    setAppliedQuery,
    setGithubProjectSearch,
    setQuery,
    setShowCreateTask,
    setShowFilterSheet,
    showHeaderCreateTask,
    t,
    taskUiReady
  } = model
  const searchable = mobileTasksSearchable(model)
  // A restored custom query can keep PR scope with no stored preset; typed words narrow that scope.
  const presetQuery = getTaskPresetQuery(
    getGitHubTaskKind(githubPreset, '') === githubKind
      ? githubPreset
      : getDefaultPresetForGitHubTaskKind(githubKind)
  )
  return (
    <BottomSearchBar
      // GitHub's preset query is the filter sheet's; the field holds only what was typed on top of it.
      value={
        isGithubProjectSearch
          ? githubProjectSearch
          : provider === 'github'
            ? githubSearchFieldText(query, presetQuery)
            : query
      }
      onChangeText={
        isGithubProjectSearch
          ? setGithubProjectSearch
          : provider === 'github'
            ? (text) => setQuery(githubQueryFromSearchField(text, presetQuery))
            : setQuery
      }
      placeholder={searchPlaceholder(model)}
      bottomInset={insets.bottom}
      leading={{
        icon: SlidersHorizontal,
        accessibilityLabel: t('tasks.searchControl.filter', 'Filter'),
        onPress: () => setShowFilterSheet(true),
        disabled: !taskUiReady,
        badge: mobileTasksFilterCount(model)
      }}
      leadingWithSearch
      onCoveredHeightChange={onCoveredHeightChange}
      // Preset text is not a search; Project’s explicit empty filter must not leave Clear visible forever.
      hasSearch={
        isGithubProjectSearch
          ? githubProjectSearch.length > 0 ||
            (appliedGithubProjectSearch !== undefined && appliedGithubProjectSearch.length > 0)
          : provider === 'github'
            ? query.trim() !== presetQuery.trim()
            : undefined
      }
      editable={taskUiReady && searchable}
      onSubmitEditing={() => {
        if (!taskUiReady) {
          return
        }
        if (isGithubProjectSearch) {
          applyGitHubProjectSearch()
          return
        }
        const nextQuery =
          provider === 'github' ? scopeGitHubTaskSearch(query, githubKind) : query.trim()
        setQuery(nextQuery)
        setAppliedQuery(nextQuery)
        if (provider === 'github') {
          persistTaskResumeState({
            githubItemsPreset:
              nextQuery.trim() === getTaskPresetQuery(githubPreset) ? githubPreset : null,
            githubItemsQuery: nextQuery.trim()
          })
        } else if (provider === 'linear') {
          persistTaskResumeState({ linearQuery: nextQuery.trim() })
        }
      }}
      onBlur={() => {
        if (isGithubProjectSearch) {
          applyGitHubProjectSearch()
        }
      }}
      onClear={() => clearMobileTasksSearch(model)}
      primary={
        // Unconnected Linear's page shows Connect instead of a new issue.
        showHeaderCreateTask && searchable
          ? {
              icon: Plus,
              accessibilityLabel:
                provider === 'github'
                  ? t('tasks.screenChrome.newGitHubIssue', 'New GitHub issue')
                  : t('tasks.screenChrome.newLinearIssue', 'New Linear issue'),
              disabled: !taskUiReady,
              onPress: () => setShowCreateTask(true)
            }
          : undefined
      }
    />
  )
}

// Project Clear means unfiltered, GitHub restores its preset, and Linear persists an empty resume.
export function clearMobileTasksSearch(model: ConnectionPresentationModel) {
  const {
    githubPreset,
    githubProjectTable,
    isGithubProjectSearch,
    persistTaskResumeState,
    provider,
    setAppliedGithubProjectSearch,
    setAppliedQuery,
    setGithubProjectSearch,
    setQuery
  } = model
  if (isGithubProjectSearch) {
    const viewFilter = githubProjectTable?.selectedView.filter ?? ''
    setGithubProjectSearch('')
    // Undefined uses the view default; empty string explicitly removes filtering.
    setAppliedGithubProjectSearch(viewFilter ? '' : undefined)
    return
  }
  if (provider === 'github') {
    const nextQuery = getTaskPresetQuery(githubPreset)
    setQuery(nextQuery)
    setAppliedQuery(nextQuery)
    persistTaskResumeState({
      githubItemsPreset: githubPreset,
      githubItemsQuery: nextQuery
    })
    return
  }
  setQuery('')
  setAppliedQuery('')
  if (provider === 'linear') {
    persistTaskResumeState({ linearQuery: '' })
  }
}
