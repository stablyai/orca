import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { Plus } from './mobile-tasks-dependencies'
import { getTaskPresetQuery, scopeGitHubTaskSearch } from './mobile-tasks-legacy-foundation'
import { translate } from '../i18n/mobile-i18n'
import { BottomSearchBar } from '../components/nav-bar/BottomSearchBar'

/** GitLab todos and unconnected sources have nothing to search. */
export function mobileTasksSearchVisible(model: ConnectionPresentationModel): boolean {
  const { gitlabView, jiraConnection, linearConnected, provider } = model
  return !(
    (provider === 'gitlab' && gitlabView === 'todos') ||
    (provider === 'linear' && !linearConnected) ||
    (provider === 'jira' && !jiraConnection.connected)
  )
}

// Search sits at the bottom with New task beside it; the list pads by the height it covers.
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
    providerLabel,
    query,
    setAppliedQuery,
    setCreateBody,
    setCreateTitle,
    setGithubProjectSearch,
    setQuery,
    setShowCreateTask,
    showHeaderCreateTask,
    taskUiReady
  } = model
  if (!mobileTasksSearchVisible(model)) {
    return null
  }
  return (
    <BottomSearchBar
      value={isGithubProjectSearch ? githubProjectSearch : query}
      onChangeText={isGithubProjectSearch ? setGithubProjectSearch : setQuery}
      placeholder={
        isGithubProjectSearch
          ? translate('tasks.searchControl.projectPlaceholder', 'Search project view...')
          : provider === 'jira'
            ? // Jira accepts raw JQL, matching desktop.
              translate(
                'tasks.searchControl.jiraPlaceholder',
                'Jira JQL, e.g. project = ABC AND statusCategory != Done'
              )
            : translate('tasks.searchControl.providerPlaceholder', 'Search {{provider}} tasks...', {
                provider: providerLabel
              })
      }
      bottomInset={insets.bottom}
      onCoveredHeightChange={onCoveredHeightChange}
      // Preset text is not a search; Project’s explicit empty filter must not leave Clear visible forever.
      hasSearch={
        isGithubProjectSearch
          ? githubProjectSearch.length > 0 ||
            (appliedGithubProjectSearch !== undefined && appliedGithubProjectSearch.length > 0)
          : provider === 'github'
            ? query.trim() !== getTaskPresetQuery(githubPreset).trim()
            : undefined
      }
      editable={taskUiReady}
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
        // Unconnected Linear has no bar; its page shows Connect instead.
        showHeaderCreateTask
          ? {
              icon: Plus,
              accessibilityLabel:
                provider === 'github'
                  ? translate('tasks.screenChrome.newGitHubIssue', 'New GitHub issue')
                  : translate('tasks.screenChrome.newLinearIssue', 'New Linear issue'),
              disabled: !taskUiReady,
              onPress: () => {
                setCreateTitle('')
                setCreateBody('')
                setShowCreateTask(true)
              }
            }
          : undefined
      }
    />
  )
}

// Project Clear means unfiltered, GitHub restores its preset, and Linear persists an empty resume.
function clearMobileTasksSearch(model: ConnectionPresentationModel) {
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
