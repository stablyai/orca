import type { PickerProjectionModel } from './use-mobile-tasks-picker-projection'
import {
  type PickerOption,
  githubProjectKey,
  useCallback,
  useMemo
} from './mobile-tasks-dependencies'
import {
  GITLAB_FILTER_OPTIONS,
  ISSUE_PRESETS,
  LINEAR_FILTER_OPTIONS,
  LINEAR_GROUP_OPTIONS,
  LINEAR_ORDER_OPTIONS,
  LINEAR_VIEW_OPTIONS,
  type LinearListEntry,
  PR_PRESETS,
  type TaskItem,
  compareLinearIssues,
  groupLinearIssues
} from './mobile-tasks-legacy-foundation'

export function useMobileTasksProviderViewProjection(model: PickerProjectionModel) {
  const {
    activeGitHubProject,
    defaultGitHubPreset,
    githubKind,
    githubMode,
    githubPreset,
    githubProjectPickerSearch,
    githubProjectSearch,
    githubProjectSettings,
    githubProjectTable,
    githubProjects,
    gitlabFilter,
    hostedRepos,
    items,
    linearDisplayProperties,
    linearFilter,
    linearGroupBy,
    linearOrderBy,
    linearTeamPropertyTouched,
    linearTeams,
    linearViewMode,
    linearWorkspaces,
    persistRepoSelection,
    selectedLinearTeamIds,
    selectedLinearWorkspaceId,
    setAppliedGithubProjectSearch,
    setSelectedRepoIds
  } = model
  const githubPresetOptions = githubKind === 'prs' ? PR_PRESETS : ISSUE_PRESETS
  const githubPresetPickerOptions = useMemo(
    () =>
      githubPresetOptions.map((option) =>
        option.value === defaultGitHubPreset
          ? { ...option, subtitle: option.subtitle ? `${option.subtitle} · Default` : 'Default' }
          : option
      ),
    [defaultGitHubPreset, githubPresetOptions]
  )
  const githubPresetLabel =
    githubPresetOptions.find((preset) => preset.value === githubPreset)?.label ?? 'Open'
  const gitlabFilterLabel =
    GITLAB_FILTER_OPTIONS.find((filter) => filter.value === gitlabFilter)?.label ?? 'Open'
  const linearFilterLabel =
    LINEAR_FILTER_OPTIONS.find((filter) => filter.value === linearFilter)?.label ?? 'All'
  const linearViewLabel =
    LINEAR_VIEW_OPTIONS.find((option) => option.value === linearViewMode)?.label ?? 'List'
  const linearGroupLabel =
    LINEAR_GROUP_OPTIONS.find((option) => option.value === linearGroupBy)?.label ?? 'No grouping'
  const linearOrderLabel =
    LINEAR_ORDER_OPTIONS.find((option) => option.value === linearOrderBy)?.label ?? 'Priority'
  const linearWorkspaceLabel =
    selectedLinearWorkspaceId === 'all'
      ? 'All workspaces'
      : (linearWorkspaces.find((workspace) => workspace.id === selectedLinearWorkspaceId)
          ?.organizationName ??
        linearWorkspaces.find((workspace) => workspace.id === selectedLinearWorkspaceId)
          ?.displayName ??
        'Workspace')
  const linearWorkspaceOptions = useMemo<PickerOption<string>[]>(
    () => [
      { value: 'all', label: 'All workspaces' },
      ...linearWorkspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.organizationName ?? workspace.displayName ?? workspace.id
      }))
    ],
    [linearWorkspaces]
  )
  const linearTeamLabel =
    selectedLinearTeamIds.size === 0 || selectedLinearTeamIds.size === linearTeams.length
      ? 'All teams'
      : selectedLinearTeamIds.size === 1
        ? (linearTeams.find((team) => selectedLinearTeamIds.has(team.id))?.name ?? '1 team')
        : `${selectedLinearTeamIds.size} teams`
  const effectiveLinearDisplayProperties = useMemo(() => {
    const next = new Set(linearDisplayProperties)
    if (linearGroupBy === 'status') {
      next.delete('state')
    }
    if (linearGroupBy === 'assignee') {
      next.delete('assignee')
    }
    if (linearGroupBy === 'priority') {
      next.delete('priority')
    }
    if (linearGroupBy === 'team') {
      next.delete('team')
    }
    if (selectedLinearTeamIds.size <= 1 && !linearTeamPropertyTouched) {
      next.delete('team')
    } else if (selectedLinearTeamIds.size > 1 && !linearTeamPropertyTouched) {
      next.add('team')
    }
    return next
  }, [
    linearDisplayProperties,
    linearGroupBy,
    linearTeamPropertyTouched,
    selectedLinearTeamIds.size
  ])
  const linearIssuesForView = useMemo(
    () =>
      items
        .filter(
          (item): item is Extract<TaskItem, { provider: 'linear' }> => item.provider === 'linear'
        )
        .map((item) => item.source)
        .sort((a, b) => compareLinearIssues(a, b, linearOrderBy)),
    [items, linearOrderBy]
  )
  const linearIssueSections = useMemo(
    () => groupLinearIssues(linearIssuesForView, linearGroupBy, linearOrderBy),
    [linearGroupBy, linearIssuesForView, linearOrderBy]
  )
  // Why: FlatList treats data identity as meaningful; unrelated renders should
  // not rebuild the section/item wrapper array.
  const linearListEntries = useMemo<LinearListEntry[]>(
    () =>
      linearIssueSections.flatMap((section) =>
        linearGroupBy === 'none'
          ? section.issues.map((issue) => ({ type: 'issue' as const, issue }))
          : [
              { type: 'section' as const, section },
              ...section.issues.map((issue) => ({ type: 'issue' as const, issue }))
            ]
      ),
    [linearGroupBy, linearIssueSections]
  )
  const linearBoardSections = useMemo(
    () =>
      groupLinearIssues(
        linearIssuesForView,
        linearGroupBy === 'none' ? 'status' : linearGroupBy,
        linearOrderBy
      ),
    [linearGroupBy, linearIssuesForView, linearOrderBy]
  )
  const githubModeLabel =
    githubMode === 'project' ? 'Projects' : githubKind === 'prs' ? 'PRs' : 'Issues'
  const activeProjectLabel = githubProjectTable
    ? githubProjectTable.project.title
    : activeGitHubProject
      ? `${activeGitHubProject.owner} #${activeGitHubProject.number}`
      : 'Choose project'
  const selectedGitHubProjectViewUrl = githubProjectTable
    ? `${githubProjectTable.project.url}/views/${githubProjectTable.selectedView.number}`
    : null
  const githubProjectsByKey = useMemo(
    () => new Map(githubProjects.map((project) => [githubProjectKey(project), project])),
    [githubProjects]
  )
  const pinnedGitHubProjects = useMemo(
    () =>
      githubProjectSettings.pinned.map((project) => ({
        ...project,
        summary: githubProjectsByKey.get(githubProjectKey(project))
      })),
    [githubProjectSettings.pinned, githubProjectsByKey]
  )
  const recentGitHubProjects = useMemo(
    () =>
      githubProjectSettings.recent
        .filter(
          (recent) =>
            !githubProjectSettings.pinned.some(
              (pinned) => githubProjectKey(pinned) === githubProjectKey(recent)
            )
        )
        .map((project) => ({
          ...project,
          summary: githubProjectsByKey.get(githubProjectKey(project))
        })),
    [githubProjectSettings.pinned, githubProjectSettings.recent, githubProjectsByKey]
  )
  const browseGitHubProjects = useMemo(() => {
    const queryText = githubProjectPickerSearch.trim().toLowerCase()
    const pinnedOrRecentKeys = new Set([
      ...githubProjectSettings.pinned.map(githubProjectKey),
      ...githubProjectSettings.recent.map(githubProjectKey)
    ])
    return githubProjects.filter((project) => {
      if (pinnedOrRecentKeys.has(githubProjectKey(project))) {
        return false
      }
      if (!queryText) {
        return true
      }
      return (
        project.title.toLowerCase().includes(queryText) ||
        project.owner.toLowerCase().includes(queryText) ||
        String(project.number).includes(queryText)
      )
    })
  }, [
    githubProjectPickerSearch,
    githubProjectSettings.pinned,
    githubProjectSettings.recent,
    githubProjects
  ])

  const toggleRepoSelection = useCallback(
    (repoId: string) => {
      setSelectedRepoIds((current) => {
        const next = new Set(current)
        if (next.has(repoId)) {
          next.delete(repoId)
        } else {
          next.add(repoId)
        }
        const normalized =
          next.size === 0 || next.size === hostedRepos.length ? new Set<string>() : next
        persistRepoSelection(normalized, hostedRepos)
        return normalized
      })
    },
    [hostedRepos, persistRepoSelection]
  )

  const applyGitHubProjectSearch = useCallback(() => {
    const viewFilter = githubProjectTable?.selectedView.filter ?? ''
    const next = githubProjectSearch
    setAppliedGithubProjectSearch(next === viewFilter ? undefined : next)
  }, [githubProjectSearch, githubProjectTable?.selectedView.filter])
  return Object.assign(model, {
    githubPresetOptions,
    githubPresetPickerOptions,
    githubPresetLabel,
    gitlabFilterLabel,
    linearFilterLabel,
    linearViewLabel,
    linearGroupLabel,
    linearOrderLabel,
    linearWorkspaceLabel,
    linearWorkspaceOptions,
    linearTeamLabel,
    effectiveLinearDisplayProperties,
    linearIssuesForView,
    linearIssueSections,
    linearListEntries,
    linearBoardSections,
    githubModeLabel,
    activeProjectLabel,
    selectedGitHubProjectViewUrl,
    githubProjectsByKey,
    pinnedGitHubProjects,
    recentGitHubProjects,
    browseGitHubProjects,
    toggleRepoSelection,
    applyGitHubProjectSearch
  })
}

export type ProviderViewProjectionModel = ReturnType<typeof useMobileTasksProviderViewProjection>
