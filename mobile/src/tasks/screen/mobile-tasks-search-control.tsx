import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { Plus } from 'lucide-react-native'
import { getTaskPresetQuery } from '../../../../src/shared/work-items/task-preset-query'
import { scopeGitHubTaskSearch } from '../../../../src/shared/work-items/task-github-search'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { BottomSearchBar } from '../../components/nav-bar/BottomSearchBar'

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
export function MobileTasksSearchControl({
  model,
  onCoveredHeightChange
}: {
  model: ConnectionPresentationModel
  onCoveredHeightChange: (height: number) => void
}) {
  const t = useMobileTranslation()
  const { isWideLayout } = useResponsiveLayout()
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
    setGithubProjectSearch,
    setQuery,
    setShowCreateTask,
    showHeaderCreateTask,
    taskUiReady
  } = model
  if (!mobileTasksSearchVisible(model)) {
    return null
  }
  const jiraSearchLabel =
    provider === 'jira'
      ? t('auto.components.TaskPage.99c2755218', 'Search issues or enter JQL, e.g. project = ABC')
      : undefined
  const jiraPlaceholder =
    jiraSearchLabel !== undefined && !isWideLayout
      ? t('tasks.searchControl.jiraCompactPlaceholder', 'Keywords or JQL')
      : jiraSearchLabel
  return (
    <BottomSearchBar
      value={isGithubProjectSearch ? githubProjectSearch : query}
      onChangeText={isGithubProjectSearch ? setGithubProjectSearch : setQuery}
      placeholder={
        isGithubProjectSearch
          ? t('tasks.searchControl.projectPlaceholder', 'Search project view...')
          : (jiraPlaceholder ??
            t('tasks.searchControl.providerPlaceholder', 'Search {{provider}} tasks...', {
              provider: providerLabel
            }))
      }
      accessibilityLabel={jiraSearchLabel}
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
