import { resolveRepoBadgeColor } from '../../../src/shared/repo-badge-color'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../src/shared/execution-host'
import {
  getHostContextLabel,
  type HostContextLabelSources
} from '../../../src/shared/worktree/host-context-labels'
import { colors } from './mobile-tasks-dependencies'
import { taskTime } from './mobile-tasks-item-mapping'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { RepoSummary } from './mobile-tasks-provider-detail-types'
import type { TaskSort } from './mobile-tasks-view-state-types'

export function repositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}

export function buildPartialRepositoryNotice(failedCount: number, totalCount: number): string {
  return `${failedCount} of ${repositoryCount(totalCount)} failed to load.`
}

export function repoColor(name: string): string {
  const palette = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return palette[Math.abs(hash) % palette.length]!
}

// Name hosts only for mixed-source lists; SSH repos retain bare paths because no target labels are available here.
export function getTaskRepoDetail(
  repo: RepoSummary,
  sources: HostContextLabelSources | null
): string {
  const hostId = getRepoExecutionHostId(repo)
  if (!sources || parseExecutionHostId(hostId)?.kind === 'ssh') {
    return repo.path
  }
  return `${getHostContextLabel(hostId, sources)} · ${repo.path}`
}

export function getRepoBadgeColor(repo: RepoSummary | undefined): string {
  return resolveRepoBadgeColor(repo?.badgeColor)
}

export function setupSourceLabel(source: string | null | undefined): string {
  if (source === 'orca.yaml') {
    return 'orca.yaml'
  }
  if (source === 'legacy') {
    return 'local hooks'
  }
  return 'repository hooks'
}

export function taskRepositoryMeta(
  item: TaskItem,
  reposById: Map<string, RepoSummary>
): { key: string; label: string; color: string } {
  if (item.provider === 'github' || item.provider === 'gitlab') {
    const repo = reposById.get(item.source.repoId)
    return {
      key: item.source.repoId,
      label: repo?.displayName ?? item.source.repoName,
      color: getRepoBadgeColor(repo)
    }
  }
  if (item.provider === 'gitlabTodo') {
    return {
      key: item.source.projectPath,
      label: item.source.projectPath,
      color: repoColor(item.source.projectPath)
    }
  }
  if (item.provider === 'jira') {
    // Jira lacks issue colors; derive a stable project color as for GitLab todos.
    return {
      key: item.source.project.id,
      label: item.source.project.name || item.source.project.key,
      color: repoColor(item.source.project.key)
    }
  }
  return {
    key: item.source.team.id,
    label: item.source.team.name,
    color: item.source.state.color || colors.accentBlue
  }
}

export function sortMobileTaskItems(
  items: readonly TaskItem[],
  sort: TaskSort,
  reposById: Map<string, RepoSummary>
): TaskItem[] {
  if (items.length < 2) {
    return [...items]
  }
  const byRepository = sort === 'repository'
  const collator = byRepository ? new Intl.Collator(undefined, { sensitivity: 'base' }) : null
  return items
    .map((item) => ({
      item,
      updatedAt: taskTime(item.updatedAt),
      repositoryLabel: byRepository ? taskRepositoryMeta(item, reposById).label : ''
    }))
    .sort(
      (a, b) =>
        (collator?.compare(a.repositoryLabel, b.repositoryLabel) ?? 0) || b.updatedAt - a.updatedAt
    )
    .map(({ item }) => item)
}
