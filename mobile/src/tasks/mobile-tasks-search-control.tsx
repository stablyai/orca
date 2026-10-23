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
    gitlabView,
    isGithubProjectSearch,
    linearConnected,
    jiraConnection,
    persistTaskResumeState,
    provider,
    providerLabel,
    query,
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
            ? 'Search this view'
            : provider === 'jira'
              ? // Matches desktop: the Jira box takes raw JQL, not free text.
                'JQL, e.g. project = ABC'
              : `Search ${providerLabel}`
        }
        accessibilityLabel={
          provider === 'jira' && !isGithubProjectSearch ? 'Search Jira with JQL' : undefined
        }
        // Why: GitHub items seed the field with a preset query, so a bare
        // value.length check would always show clear. Project mode shows clear
        // for draft text or a non-empty applied override — not for applied ''
        // (explicit unfiltered after clear), or the button sticks forever.
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
        onClear={() => clearMobileTasksSearch(model)}
      />
    </View>
  )
}

/**
 * Clears the field the way each source reads "nothing searched": Project mode means unfiltered (a ''
 * override when the view has its own filter), GitHub items restore the preset's query, and the
 * others clear and persist an empty resume.
 */
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
    // Why: undefined = use view default; '' = explicit unfiltered override.
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
