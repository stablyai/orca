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
    !linearConnected ? null : (
    <View style={styles.searchBar}>
      <MobileSearchField
        value={isGithubProjectSearch ? githubProjectSearch : query}
        onChangeText={isGithubProjectSearch ? setGithubProjectSearch : setQuery}
        placeholder={
          isGithubProjectSearch ? 'Search project view...' : `Search ${providerLabel} tasks...`
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
        // Why: Project clear means unfiltered results ('' override when the view
        // has a default filter), not restore view default. GitHub items clear
        // restores the preset query. Linear clears and persists empty resume.
        onClear={() => {
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
        }}
      />
    </View>
  )
}
