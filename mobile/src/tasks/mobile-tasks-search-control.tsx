import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { View, MobileSearchField } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { getTaskPresetQuery, scopeGitHubTaskSearch } from './mobile-tasks-legacy-foundation'

export function renderMobileTasksSearchControl(model: ConnectionPresentationModel) {
  const {
    appliedGithubProjectSearch,
    applyGitHubProjectSearch,
    githubKind,
    githubPreset,
    githubProjectSearch,
    githubProjectTable,
    gitlabView,
    isGithubProjectSearch,
    linearConnected,
    jiraConnection,
    persistTaskResumeState,
    provider,
    providerLabel,
    query,
    setAppliedGithubProjectSearch,
    setAppliedQuery,
    setGithubProjectSearch,
    setQuery,
    taskUiReady
  } = model
  return provider === 'gitlab' && gitlabView === 'todos' ? null : provider === 'linear' &&
    !linearConnected ? null : provider === 'jira' && !jiraConnection.connected ? null : (
    <View style={styles.searchBar}>
      <MobileSearchField
        value={isGithubProjectSearch ? githubProjectSearch : query}
        onChangeText={isGithubProjectSearch ? setGithubProjectSearch : setQuery}
        placeholder={
          isGithubProjectSearch
            ? 'Search project view...'
            : provider === 'jira'
              ? // Jira accepts raw JQL, matching desktop.
                'Jira JQL, e.g. project = ABC AND statusCategory != Done'
              : `Search ${providerLabel} tasks...`
        }
        // Preset text is not an override; Project’s explicit empty filter must not leave Clear visible forever.
        showClear={
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
        // Project Clear means unfiltered, GitHub restores its preset, and Linear persists empty resume.
        onClear={() => {
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
        }}
      />
    </View>
  )
}
