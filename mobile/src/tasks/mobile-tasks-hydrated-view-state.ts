import type { TaskProvider } from '../../../src/shared/task-providers'
import { resolveVisibleTaskProvider } from './mobile-tasks-dependencies'
import { normalizeJiraFilter } from './mobile-jira-issue-filters'
import {
  type RuntimeTaskSettings,
  type TaskResumeState,
  getTaskPresetQuery,
  githubKindFromQuery,
  isTaskProvider,
  normalizeGitHubPreset,
  normalizeLinearFilter,
  scopeGitHubTaskSearch
} from './mobile-tasks-legacy-foundation'

/** The view state a hydrate commits: which provider is showing and what each one's controls hold. */
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

/**
 * Folds the persisted resume state and host settings into the controls the screen mounts with.
 *
 * Pure, and separate from the hydration effect for that reason: every provider's preset, filter
 * and query resolution lands here, so adding one is a branch in this function rather than another
 * pair of locals inside an effect that already commits sixteen setters.
 */
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
  // A null preset is the user having cleared it, which keeps their typed query; an absent one
  // falls back to the host default.
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
