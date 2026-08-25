import { colors } from '@/theme'
import type { RepoSummary, TaskItem } from './mobile-task-items'

const REPO_BADGE_PALETTE = [
  '#f97316',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f59e0b',
  '#6366f1'
]

export function repoColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return REPO_BADGE_PALETTE[Math.abs(hash) % REPO_BADGE_PALETTE.length]!
}

export function getRepoBadgeColor(repo: RepoSummary | undefined, fallbackName: string): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? fallbackName)
}

export function taskTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
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
  if (item.provider === 'clickup') {
    return {
      key: item.source.workspaceId,
      label: item.source.workspaceName ?? item.source.list.name,
      color: item.source.status.color || colors.accentBlue
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

