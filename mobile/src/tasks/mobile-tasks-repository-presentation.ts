import { colors } from './mobile-tasks-dependencies'
import { taskTime } from './mobile-tasks-item-mapping'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { RepoSummary } from './mobile-tasks-provider-detail-types'

export function isFailedGitHubCheck(check: { conclusion?: string | null }): boolean {
  return ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? '')
}

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

export function getRepoBadgeColor(repo: RepoSummary | undefined, fallbackName: string): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? fallbackName)
}

export function setupSourceLabel(source: string | null): string {
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
      color: getRepoBadgeColor(repo, item.source.repoName)
    }
  }
  if (item.provider === 'gitlabTodo') {
    return {
      key: item.source.projectPath,
      label: item.source.projectPath,
      color: repoColor(item.source.projectPath)
    }
  }
  return {
    key: item.source.team.id,
    label: item.source.team.name,
    color: item.source.state.color || colors.accentBlue
  }
}

export function compareTasksByUpdated(a: TaskItem, b: TaskItem): number {
  return taskTime(b.updatedAt) - taskTime(a.updatedAt)
}

export function compareTasksByRepository(
  a: TaskItem,
  b: TaskItem,
  reposById: Map<string, RepoSummary>
): number {
  const aRepo = taskRepositoryMeta(a, reposById)
  const bRepo = taskRepositoryMeta(b, reposById)
  const repoComparison = aRepo.label.localeCompare(bRepo.label, undefined, { sensitivity: 'base' })
  return repoComparison || compareTasksByUpdated(a, b)
}
