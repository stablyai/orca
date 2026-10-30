import type { DetailCommentRenderersModel } from './use-mobile-tasks-detail-comment-renderers'
import { type PickerOption, View, useMemo, useMobileColorScheme } from './mobile-tasks-dependencies'
import {
  type GitHubRepoSources,
  PROJECT_VIEW_DEFAULT_SORT,
  PROVIDER_OPTIONS,
  type RepoSummary,
  SORT_OPTIONS,
  type TaskListEntry,
  sortMobileTaskItems,
  getRepoBadgeColor,
  getTaskRepoDetail,
  hasGitHubIssueSourceChoice,
  issueSourceSlug,
  taskRepositoryMeta
} from './mobile-tasks-legacy-foundation'
import { styles } from './mobile-tasks-legacy-styles'
import { PROVIDER_LABELS } from './mobile-task-view-options'
import { jiraSiteLabel } from './jira-mobile-connection'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

function sourceCountLabel(count: number, t: Translate): string {
  return count === 1
    ? t('tasks.pickerProjection.sources_one', '{{count}} source', { count })
    : t('tasks.pickerProjection.sources_other', '{{count}} sources', { count })
}

function repoCountLabel(count: number, t: Translate): string {
  return count === 1
    ? t('tasks.pickerProjection.repos_one', '{{count}} repo', { count })
    : t('tasks.pickerProjection.repos_other', '{{count}} repos', { count })
}

export function useMobileTasksPickerProjection(model: DetailCommentRenderersModel) {
  const t = useMobileTranslation()
  const colorScheme = useMobileColorScheme()
  const {
    createRepoId,
    createTeamId,
    githubMode,
    githubProjectAvailableSummaryFields,
    githubProjectSortOverride,
    githubProjectSummaryFields,
    githubProjectTable,
    githubProjectViews,
    githubRepoSources,
    hostedRepos,
    items,
    jiraConnection,
    linearTeams,
    provider,
    reposById,
    selectedHostedRepos,
    effectiveRepoIds,
    repoHostLabels,
    taskSort,
    visibleProviders,
    workspaceRepos
  } = model
  const createTargetOptions = useMemo<PickerOption<string>[]>(
    () =>
      provider === 'github' || provider === 'gitlab'
        ? hostedRepos.map((repo) => ({
            value: repo.id,
            label: repo.displayName,
            subtitle: getTaskRepoDetail(repo, repoHostLabels),
            renderIcon: () => (
              <View style={[styles.pickerRepoDot, { backgroundColor: getRepoBadgeColor(repo) }]} />
            )
          }))
        : linearTeams.map((team) => ({
            value: team.id,
            label: team.name,
            subtitle: team.workspaceName
          })),
    [hostedRepos, linearTeams, provider, repoHostLabels, t]
  )
  const selectedCreateRepo =
    provider === 'github' || provider === 'gitlab'
      ? (hostedRepos.find((repo) => repo.id === createRepoId) ?? hostedRepos[0] ?? null)
      : null
  const selectedCreateTeam =
    provider === 'github' || provider === 'gitlab'
      ? null
      : (linearTeams.find((team) => team.id === createTeamId) ?? linearTeams[0] ?? null)
  const selectedCreateTarget = selectedCreateRepo ?? selectedCreateTeam
  const selectedCreateTargetLabel =
    selectedCreateRepo?.displayName ??
    selectedCreateTeam?.name ??
    t('tasks.pickerProjection.selectTarget', 'Select target')
  const providerLabel = PROVIDER_LABELS[provider]
  const showHeaderCreateTask =
    provider === 'linear' || (provider === 'github' && githubMode === 'items')
  const jiraSiteOptions = useMemo<PickerOption<string>[]>(
    () => [
      { value: 'all', label: t('tasks.pickerProjection.allSites', 'All sites') },
      ...jiraConnection.sites.map((site) => ({
        value: site.id,
        label: jiraSiteLabel(site),
        subtitle: site.siteUrl
      }))
    ],
    [jiraConnection.sites, t]
  )
  const providerOptions = useMemo(
    () => PROVIDER_OPTIONS.filter((option) => visibleProviders.includes(option.value)),
    [t, visibleProviders]
  )
  const selectedCreateGitHubSources =
    provider === 'github' && selectedCreateRepo
      ? githubRepoSources[selectedCreateRepo.id]
      : undefined
  const selectedCreateIssuePreference =
    selectedCreateRepo?.issueSourcePreference === 'origin' ||
    selectedCreateRepo?.issueSourcePreference === 'upstream'
      ? selectedCreateRepo.issueSourcePreference
      : 'upstream'
  const githubIssueSourceRows = useMemo(
    () =>
      selectedHostedRepos
        .map((repo) => ({ repo, sources: githubRepoSources[repo.id] }))
        .filter((entry): entry is { repo: RepoSummary; sources: GitHubRepoSources } =>
          hasGitHubIssueSourceChoice(entry.sources)
        ),
    [githubRepoSources, selectedHostedRepos]
  )
  const githubIssueSourceLabel =
    githubIssueSourceRows.length === 1
      ? issueSourceSlug(
          githubIssueSourceRows[0]!.repo.issueSourcePreference === 'origin'
            ? githubIssueSourceRows[0]!.sources.prs
            : githubIssueSourceRows[0]!.sources.upstreamCandidate
        )
      : sourceCountLabel(githubIssueSourceRows.length, t)
  const repoPickerLabel =
    effectiveRepoIds.size === 0 || selectedHostedRepos.length === hostedRepos.length
      ? t('tasks.pickerProjection.allRepos', 'All repos')
      : selectedHostedRepos.length === 1
        ? selectedHostedRepos[0]!.displayName
        : repoCountLabel(selectedHostedRepos.length, t)
  const repoPickerSelectedRepo =
    effectiveRepoIds.size > 0 && selectedHostedRepos.length === 1 ? selectedHostedRepos[0]! : null
  const workspaceRepoOptions = useMemo<PickerOption<string>[]>(
    () =>
      workspaceRepos.map((repo) => ({
        value: repo.id,
        label: repo.displayName,
        subtitle: getTaskRepoDetail(repo, repoHostLabels),
        renderIcon: () => (
          <View style={[styles.pickerRepoDot, { backgroundColor: getRepoBadgeColor(repo) }]} />
        )
      })),
    [repoHostLabels, t, workspaceRepos]
  )
  const sortedItems = useMemo(
    () => sortMobileTaskItems(items, taskSort, reposById),
    [items, reposById, taskSort]
  )
  const displayedEntries = useMemo<TaskListEntry[]>(() => {
    if (taskSort !== 'repository') {
      return sortedItems.map((item) => ({ type: 'item', key: item.key, item }))
    }
    const entries: TaskListEntry[] = []
    let previousRepoKey = ''
    for (const item of sortedItems) {
      const repo = taskRepositoryMeta(item, reposById)
      if (repo.key !== previousRepoKey) {
        entries.push({
          type: 'section',
          key: `section:${repo.key}`,
          label: repo.label,
          color: repo.color
        })
        previousRepoKey = repo.key
      }
      entries.push({ type: 'item', key: item.key, item })
    }
    return entries
  }, [colorScheme, reposById, sortedItems, t, taskSort])
  const sortLabel =
    SORT_OPTIONS.find((option) => option.value === taskSort)?.label ??
    t('tasks.pickerProjection.updatedSort', 'Updated')
  const githubProjectFields = githubProjectTable?.selectedView.fields ?? []
  const githubProjectViewSort = githubProjectTable?.selectedView.sortByFields?.[0] ?? null
  const githubProjectSortField = githubProjectSortOverride
    ? githubProjectFields.find((field) => field.id === githubProjectSortOverride.fieldId)
    : githubProjectViewSort?.field
  const githubProjectSortDirection =
    githubProjectSortOverride?.direction ?? githubProjectViewSort?.direction ?? null
  const githubProjectSortLabel = githubProjectSortField
    ? githubProjectSortDirection === 'DESC'
      ? t('tasks.pickerProjection.fieldDescending', '{{field}} desc', {
          field: githubProjectSortField.name
        })
      : t('tasks.pickerProjection.fieldAscending', '{{field}} asc', {
          field: githubProjectSortField.name
        })
    : t('tasks.pickerProjection.viewOrder', 'View order')
  const githubProjectFieldsLabel =
    githubProjectAvailableSummaryFields.length > 0
      ? t('tasks.pickerProjection.selectedFields', '{{selected}}/{{total}} fields', {
          selected: githubProjectSummaryFields.length,
          total: githubProjectAvailableSummaryFields.length
        })
      : t('tasks.pickerProjection.fields', 'Fields')
  const githubProjectSortOptions = useMemo<PickerOption<string>[]>(
    () => [
      {
        value: PROJECT_VIEW_DEFAULT_SORT,
        label: t('tasks.pickerProjection.viewOrder', 'View order'),
        subtitle: githubProjectViewSort
          ? githubProjectViewSort.direction === 'DESC'
            ? t('tasks.pickerProjection.usesFieldDescending', 'Uses {{field}} desc', {
                field: githubProjectViewSort.field.name
              })
            : t('tasks.pickerProjection.usesFieldAscending', 'Uses {{field}} asc', {
                field: githubProjectViewSort.field.name
              })
          : t('tasks.pickerProjection.usesGitHubRankOrder', 'Uses GitHub rank order')
      },
      ...githubProjectFields.map((field) => {
        const active = githubProjectSortOverride?.fieldId === field.id
        return {
          value: field.id,
          label: field.name,
          subtitle: active
            ? githubProjectSortOverride.direction === 'DESC'
              ? t(
                  'tasks.pickerProjection.currentlyDescending',
                  'Currently desc · tap for ascending'
                )
              : t('tasks.pickerProjection.currentlyAscending', 'Currently asc · tap for descending')
            : t('tasks.pickerProjection.sortAscending', 'Sort ascending')
        }
      })
    ],
    [githubProjectFields, githubProjectSortOverride, githubProjectViewSort, t]
  )
  const githubProjectViewOptions = useMemo<PickerOption<string>[]>(
    () =>
      githubProjectViews.map((view) => ({
        value: view.id,
        label: view.name,
        subtitle:
          view.layout === 'TABLE_LAYOUT'
            ? t('tasks.pickerProjection.viewNumber', 'View #{{number}}', { number: view.number })
            : t('tasks.pickerProjection.unsupportedLayout', 'Unsupported layout on mobile'),
        disabled: view.layout !== 'TABLE_LAYOUT'
      })),
    [githubProjectViews, t]
  )
  return Object.assign(model, {
    createTargetOptions,
    selectedCreateTarget,
    selectedCreateTargetLabel,
    jiraSiteOptions,
    providerLabel,
    showHeaderCreateTask,
    providerOptions,
    selectedCreateRepo,
    selectedCreateGitHubSources,
    selectedCreateIssuePreference,
    githubIssueSourceRows,
    githubIssueSourceLabel,
    repoPickerLabel,
    repoPickerSelectedRepo,
    workspaceRepoOptions,
    sortedItems,
    displayedEntries,
    sortLabel,
    githubProjectFields,
    githubProjectViewSort,
    githubProjectSortField,
    githubProjectSortDirection,
    githubProjectSortLabel,
    githubProjectFieldsLabel,
    githubProjectSortOptions,
    githubProjectViewOptions
  })
}

export type PickerProjectionModel = ReturnType<typeof useMobileTasksPickerProjection>
