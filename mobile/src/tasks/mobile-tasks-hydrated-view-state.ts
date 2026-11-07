import { isTaskProvider, type TaskProvider } from '../../../src/shared/task-providers'
import { resolveVisibleTaskProvider } from './mobile-tasks-dependencies'
import { normalizeJiraFilter } from './mobile-jira-issue-filters'
import {
  type RuntimeTaskSettings,
  type TaskResumeState,
  getTaskPresetQuery,
  githubKindFromQuery,
  normalizeGitHubPreset,
  normalizeLinearFilter,
  scopeGitHubTaskSearch
} from './mobile-tasks-legacy-foundation'

export type HydratedTaskViewState = {
  provider: TaskProvider
  githubPreset: ReturnType<typeof normalizeGitHubPreset>
  defaultGithubPreset: ReturnType<typeof normalizeGitHubPreset>
  githubKind: ReturnType<typeof githubKindFromQuery>
  linearFilter: ReturnType<typeof normalizeLinearFilter>
  jiraFilter: ReturnType<typeof normalizeJiraFilter>
  query: string
  appliedQuery: string
}

export function resolveHydratedTaskViewState(args: {
  settings: RuntimeTaskSettings
  resume: TaskResumeState
  requestedTaskSource: TaskProvider | undefined
  visibleProviders: TaskProvider[]
}): HydratedTaskViewState {
  const { settings, resume, requestedTaskSource, visibleProviders } = args
  const provider =
    requestedTaskSource && visibleProviders.includes(requestedTaskSource)
      ? requestedTaskSource
      : resolveVisibleTaskProvider(
          isTaskProvider(settings.defaultTaskSource) ? settings.defaultTaskSource : undefined,
          visibleProviders
        )
  // A cleared preset preserves the typed query; an absent preset uses the host default.
  const githubPreset =
    resume.githubItemsPreset === null
      ? normalizeGitHubPreset(settings.defaultTaskViewPreset)
      : normalizeGitHubPreset(resume.githubItemsPreset ?? settings.defaultTaskViewPreset)
  const githubQuery =
    resume.githubItemsPreset === null
      ? (resume.githubItemsQuery ?? '')
      : getTaskPresetQuery(githubPreset)
  const query =
    provider === 'github'
      ? githubQuery
      : provider === 'linear'
        ? (resume.linearQuery ?? '')
        : provider === 'jira'
          ? (resume.jiraQuery ?? '')
          : ''
  return {
    provider,
    githubPreset,
    defaultGithubPreset: normalizeGitHubPreset(settings.defaultTaskViewPreset),
    githubKind: githubKindFromQuery(githubQuery, githubPreset),
    linearFilter: normalizeLinearFilter(resume.linearPreset),
    jiraFilter: normalizeJiraFilter(resume.jiraPreset),
    query,
    appliedQuery:
      provider === 'github'
        ? scopeGitHubTaskSearch(githubQuery, githubKindFromQuery(githubQuery, githubPreset))
        : query
  }
}
