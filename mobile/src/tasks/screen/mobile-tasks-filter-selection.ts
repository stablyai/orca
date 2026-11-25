import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import type { TaskProvider } from '../../../../src/shared/work-items/task-providers'
import type { JiraIssueFilter } from '../../../../src/shared/jira/jira-types'
import { translate } from '../../i18n/mobile-i18n'
import {
  normalizeGitHubPreset,
  githubKindFromQuery,
  normalizeLinearFilter
} from '../item-detail/mobile-tasks-item-mapping'
import { getTaskPresetQuery } from '../../../../src/shared/work-items/task-preset-query'
import {
  getDefaultPresetForGitHubTaskKind,
  scopeGitHubTaskSearch
} from '../../../../src/shared/work-items/task-github-search'
import { normalizeJiraFilter } from '../providers/jira/mobile-jira-issue-filters'
import { linearWorkspaceSelect } from '../screen-state/mobile-task-runtime-operations'
import { linearAccountClient } from '../task-list/linear-account-host'
import type {
  GitHubMode,
  GitHubPreset,
  GitLabView,
  LinearFilter
} from '../mobile-tasks-view-state-types'

// Restores the provider's last view and query so switching sources round-trips.
export function selectMobileTasksProvider(model: ConnectionPresentationModel, next: TaskProvider) {
  const {
    githubPreset,
    persistTaskSource,
    setAppliedQuery,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setItems,
    setLinearFilter,
    setJiraFilter,
    setProvider,
    setQuery,
    taskResumeRef
  } = model
  const resume = taskResumeRef.current
  persistTaskSource(next)
  setProvider(next)
  setItems([])
  if (next === 'github') {
    const nextMode = resume.githubMode === 'project' ? 'project' : 'items'
    setGithubMode(nextMode)
    if (nextMode === 'project') {
      setQuery('')
      setAppliedQuery('')
      return
    }
    const preset =
      resume.githubItemsPreset === null
        ? githubPreset
        : normalizeGitHubPreset(resume.githubItemsPreset ?? githubPreset)
    const nextQuery =
      resume.githubItemsPreset === null
        ? (resume.githubItemsQuery ?? '')
        : getTaskPresetQuery(preset)
    const nextKind = githubKindFromQuery(nextQuery, preset)
    setGithubPreset(preset)
    setGithubKind(nextKind)
    setQuery(nextQuery)
    setAppliedQuery(scopeGitHubTaskSearch(nextQuery, nextKind))
  } else if (next === 'linear') {
    const nextQuery = resume.linearQuery ?? ''
    setLinearFilter(normalizeLinearFilter(resume.linearPreset))
    setQuery(nextQuery)
    setAppliedQuery(nextQuery.trim())
  } else if (next === 'jira') {
    const nextQuery = resume.jiraQuery ?? ''
    setJiraFilter(normalizeJiraFilter(resume.jiraPreset))
    setQuery(nextQuery)
    setAppliedQuery(nextQuery.trim())
  } else {
    setQuery('')
    setAppliedQuery('')
  }
}

export function selectMobileTasksGitHubKind(model: ConnectionPresentationModel, kind: GitHubMode) {
  const {
    persistTaskResumeState,
    setAppliedQuery,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setItems,
    setQuery
  } = model
  if (kind === 'project') {
    setGithubMode('project')
    setItems([])
    persistTaskResumeState({ githubMode: 'project' })
    return
  }
  const preset = kind === 'prs' ? 'prs' : 'issues'
  const nextQuery = getTaskPresetQuery(preset)
  setGithubMode('items')
  setGithubKind(kind)
  setGithubPreset(preset)
  setQuery(nextQuery)
  setAppliedQuery(nextQuery)
  persistTaskResumeState({
    githubMode: 'items',
    githubItemsPreset: preset,
    githubItemsQuery: nextQuery
  })
}

export function selectMobileTasksGitHubPreset(
  model: ConnectionPresentationModel,
  preset: GitHubPreset
) {
  const nextQuery = getTaskPresetQuery(preset)
  model.setGithubMode('items')
  model.setGithubKind(preset === 'issues' || preset === 'my-issues' ? 'issues' : 'prs')
  model.setGithubPreset(preset)
  model.setQuery(nextQuery)
  model.setAppliedQuery(nextQuery)
  model.persistTaskResumeState({ githubItemsPreset: preset, githubItemsQuery: nextQuery })
}

export function selectMobileTasksGitLabView(model: ConnectionPresentationModel, view: GitLabView) {
  model.setGitlabView(view)
  if (view === 'todos') {
    // GitLab Todos has no server search query; clear item filters instead of carrying an invisible one.
    model.setQuery('')
    model.setAppliedQuery('')
  }
}

export function selectMobileTasksLinearFilter(
  model: ConnectionPresentationModel,
  filter: LinearFilter
) {
  model.setLinearFilter(filter)
  model.setQuery('')
  model.setAppliedQuery('')
  model.persistTaskResumeState({ linearPreset: filter, linearQuery: '' })
}

export function selectMobileTasksJiraFilter(
  model: ConnectionPresentationModel,
  filter: JiraIssueFilter
) {
  model.setJiraFilter(filter)
  model.setQuery('')
  model.setAppliedQuery('')
  model.persistTaskResumeState({ jiraPreset: filter, jiraQuery: '' })
}

export function selectMobileTasksLinearWorkspace(
  model: ConnectionPresentationModel,
  workspaceId: string
) {
  const { client, linearAccountBindingRef, loadLinearContext, setError } = model
  model.setSelectedLinearWorkspaceId(workspaceId)
  model.setSelectedLinearTeamIds(new Set())
  if (!client) {
    return
  }
  void linearAccountClient(linearAccountBindingRef.current, client)
    .then((target) => linearWorkspaceSelect.request(target, { workspaceId }))
    .then(() => loadLinearContext())
    .catch((err) => {
      setError(
        err instanceof Error
          ? err.message
          : translate('tasks.filterPickers.switchWorkspaceFailed', 'Failed to switch workspace')
      )
    })
}

function githubPresetIsDefault(model: ConnectionPresentationModel): boolean {
  return (
    model.githubPreset === getDefaultPresetForGitHubTaskKind(model.githubKind) ||
    model.githubPreset === model.defaultGitHubPreset
  )
}

function reposNarrowed(model: ConnectionPresentationModel): boolean {
  return model.effectiveRepoIds.size > 0 && model.effectiveRepoIds.size < model.hostedRepos.length
}

/** How many filters differ from their defaults; the bar's filter button shows it. */
export function mobileTasksFilterCount(model: ConnectionPresentationModel): number {
  const { provider } = model
  const count = (...flags: boolean[]) => flags.filter(Boolean).length
  if (provider === 'github' && model.githubMode === 'project') {
    // Hidden fields are a display choice, like Linear's Show on rows, not a filter.
    return count(model.githubProjectSortOverride !== null)
  }
  if (provider === 'github') {
    return count(reposNarrowed(model), !githubPresetIsDefault(model), model.taskSort !== 'updated')
  }
  if (provider === 'gitlab') {
    return count(
      reposNarrowed(model),
      model.gitlabView === 'project' && model.gitlabFilter !== 'opened',
      model.taskSort !== 'updated'
    )
  }
  if (provider === 'linear') {
    const teams = model.selectedLinearTeamIds.size
    return count(
      teams > 0 && teams < model.linearTeams.length,
      model.linearFilter !== 'all',
      model.linearViewMode !== 'list',
      model.linearGroupBy !== 'none',
      model.linearOrderBy !== 'priority'
    )
  }
  return count(
    // One site is no narrowing even though its id is the selection.
    model.jiraConnection.sites.length > 1 &&
      Boolean(model.jiraConnection.selection) &&
      model.jiraConnection.selection !== 'all',
    model.jiraFilter !== 'assigned' && model.appliedQuery.trim() === '',
    model.taskSort !== 'updated'
  )
}

export function resetMobileTasksFilters(model: ConnectionPresentationModel): void {
  const { provider } = model
  if (provider === 'github' && model.githubMode === 'project') {
    model.setGithubProjectSortOverride(null)
    return
  }
  if (provider === 'github' || provider === 'gitlab') {
    if (reposNarrowed(model)) {
      const all = new Set<string>()
      model.setSelectedRepoIds(all)
      model.persistRepoSelection(all, model.hostedRepos)
    }
    if (provider === 'github' && !githubPresetIsDefault(model)) {
      selectMobileTasksGitHubPreset(
        model,
        normalizeGitHubPreset(getDefaultPresetForGitHubTaskKind(model.githubKind))
      )
    }
    if (provider === 'gitlab') {
      model.setGitlabFilter('opened')
    }
    model.setTaskSort('updated')
    return
  }
  if (provider === 'linear') {
    const allTeams = new Set(model.linearTeams.map((team) => team.id))
    model.setSelectedLinearTeamIds(allTeams)
    model.persistLinearTeamSelection(allTeams, model.linearTeams)
    if (model.linearFilter !== 'all') {
      selectMobileTasksLinearFilter(model, 'all')
    }
    model.setLinearViewMode('list')
    model.setLinearGroupBy('none')
    model.setLinearOrderBy('priority')
    return
  }
  if (model.jiraConnection.sites.length > 1) {
    model.setJiraConnection((current) => ({ ...current, selection: 'all' }))
  }
  if (model.jiraFilter !== 'assigned') {
    selectMobileTasksJiraFilter(model, 'assigned')
  }
  model.setTaskSort('updated')
}
