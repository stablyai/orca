import {
  type RpcSuccess,
  type TaskProvider,
  type GitHubOwnerRepo,
  colors
} from './mobile-tasks-dependencies'
import type {
  GitHubPreset,
  GitHubProjectRow,
  GitHubTaskKind,
  LinearFilter
} from './mobile-tasks-view-state-types'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type {
  GitHubWorkItem,
  GitLabTodo,
  GitLabWorkItem,
  LinearIssue,
  RepoSummary
} from './mobile-tasks-provider-detail-types'

export function isSuccess(response: unknown): response is RpcSuccess {
  return Boolean(response && typeof response === 'object' && (response as RpcSuccess).ok)
}

export function taskTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

export function formatUpdatedAt(value: string): string {
  const time = taskTime(value)
  if (!time) {
    return ''
  }
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

export function getTaskPresetQuery(preset: GitHubPreset): string {
  switch (preset) {
    case 'my-issues':
      return 'assignee:@me is:issue is:open'
    case 'prs':
      return 'is:pr is:open'
    case 'my-prs':
      return 'author:@me is:pr is:open'
    case 'review':
      return 'review-requested:@me is:pr is:open'
    case 'issues':
    default:
      return 'is:issue is:open'
  }
}

export function isTaskProvider(value: unknown): value is TaskProvider {
  return value === 'github' || value === 'gitlab' || value === 'linear'
}

export function normalizeGitHubPreset(value: unknown): GitHubPreset {
  return value === 'my-issues' ||
    value === 'prs' ||
    value === 'my-prs' ||
    value === 'review' ||
    value === 'issues'
    ? value
    : 'issues'
}

export function normalizeLinearFilter(value: unknown): LinearFilter {
  return value === 'assigned' || value === 'created' || value === 'completed' || value === 'all'
    ? value
    : 'all'
}

export function githubKindFromQuery(query: string, fallbackPreset: GitHubPreset): GitHubTaskKind {
  if (/\bis:pr\b/i.test(query)) {
    return 'prs'
  }
  if (/\bis:issue\b/i.test(query)) {
    return 'issues'
  }
  return fallbackPreset === 'prs' || fallbackPreset === 'my-prs' || fallbackPreset === 'review'
    ? 'prs'
    : 'issues'
}

export function projectRowType(row: GitHubProjectRow): 'issue' | 'pr' | null {
  if (row.itemType === 'ISSUE') {
    return 'issue'
  }
  if (row.itemType === 'PULL_REQUEST') {
    return 'pr'
  }
  return null
}

export function canCreateWorkspaceFromProjectRow(row: GitHubProjectRow): boolean {
  // Why: desktop only exposes Project "Start work" for backed issue/PR rows
  // with enough GitHub identity to build the linked work item.
  return projectRowType(row) !== null && row.content.number != null && Boolean(row.content.url)
}

export function splitRepositorySlug(slug: string | null): { owner: string; repo: string } | null {
  const [owner, repo] = slug?.split('/') ?? []
  return owner && repo ? { owner, repo } : null
}

export function projectRowGitHubRepository(
  row: GitHubProjectRow,
  host: string
): GitHubOwnerRepo | null {
  const slug = splitRepositorySlug(row.content.repository)
  return slug ? { ...slug, host } : null
}

export const GITHUB_PROJECT_OPTION_COLORS: Record<string, string> = {
  GRAY: '#8b949e',
  RED: '#f85149',
  ORANGE: '#db6d28',
  YELLOW: '#d29922',
  GREEN: '#3fb950',
  BLUE: '#58a6ff',
  PURPLE: '#bc8cff',
  PINK: '#db61a2'
}

export function githubProjectOptionColor(color: string | null | undefined): string {
  if (!color) {
    return colors.textMuted
  }
  const upper = color.toUpperCase()
  const mapped = GITHUB_PROJECT_OPTION_COLORS[upper]
  if (mapped) {
    return mapped
  }
  const hex = color.startsWith('#') ? color : `#${color}`
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : colors.textMuted
}

export function projectRowStatusLabel(row: GitHubProjectRow): string {
  if (row.itemType === 'DRAFT_ISSUE') {
    return 'Draft'
  }
  if (row.itemType === 'REDACTED') {
    return 'Redacted'
  }
  if (row.content.isDraft) {
    return 'Draft'
  }
  if (row.content.state === 'MERGED') {
    return 'Merged'
  }
  if (row.content.state === 'CLOSED') {
    return 'Closed'
  }
  return 'Open'
}

export function scopeGitHubTaskSearch(query: string, kind: GitHubTaskKind): string {
  const trimmed = query.trim()
  if (!trimmed) {
    return getTaskPresetQuery(kind === 'prs' ? 'prs' : 'issues')
  }
  if (/\bis:(?:issue|pr)\b/i.test(trimmed)) {
    return trimmed
  }
  return `${kind === 'prs' ? 'is:pr' : 'is:issue'} ${trimmed}`
}

export function gitHubStatusLabel(item: GitHubWorkItem): string {
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

export function gitHubTaskSubtitle(item: GitHubWorkItem): string {
  return `${item.repoName} ${item.type === 'pr' ? '#' : '#'}${item.number}`
}

export function createGitHubTask(
  repo: RepoSummary,
  item: Omit<GitHubWorkItem, 'repoId' | 'repoName'>
) {
  const source: GitHubWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `github:${repo.id}:${item.type}:${item.number}`,
    provider: 'github' as const,
    title: item.title,
    subtitle: gitHubTaskSubtitle(source),
    status: gitHubStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

export function gitLabStatusLabel(item: GitLabWorkItem): string {
  if (item.state === 'opened') {
    return 'Open'
  }
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Locked'
}

export function createGitLabTask(
  repo: RepoSummary,
  item: Omit<GitLabWorkItem, 'repoId' | 'repoName'>
) {
  const source: GitLabWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `gitlab:${repo.id}:${item.type}:${item.number}`,
    provider: 'gitlab' as const,
    title: item.title,
    subtitle: `${repo.displayName} ${item.type === 'mr' ? '!' : '#'}${item.number}`,
    status: gitLabStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

export function gitLabTodoTargetLabel(todo: Pick<GitLabTodo, 'targetType'>): string {
  if (todo.targetType === 'MergeRequest') {
    return 'Merge request'
  }
  if (todo.targetType === 'Issue') {
    return 'Issue'
  }
  return 'GitLab todo'
}

export function gitLabTodoTargetRef(todo: Pick<GitLabTodo, 'targetType' | 'targetIid'>): string {
  if (!todo.targetIid) {
    return ''
  }
  if (todo.targetType === 'MergeRequest') {
    return `!${todo.targetIid}`
  }
  if (todo.targetType === 'Issue') {
    return `#${todo.targetIid}`
  }
  return String(todo.targetIid)
}

export function createGitLabTodoTask(todo: GitLabTodo): TaskItem {
  const targetRef = gitLabTodoTargetRef(todo)
  return {
    key: `gitlab-todo:${todo.id}`,
    provider: 'gitlabTodo',
    title: todo.targetTitle || todo.targetUrl,
    subtitle: `${todo.projectPath}${targetRef ? ` ${targetRef}` : ''}`,
    status: todo.actionName.replace(/_/g, ' ') || 'Todo',
    updatedAt: todo.updatedAt,
    source: todo
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

export function createLinearTask(issue: LinearIssue): TaskItem {
  return {
    key: `linear:${issue.workspaceId ?? 'workspace'}:${issue.id}`,
    provider: 'linear',
    title: issue.title,
    subtitle: `${issue.identifier} · ${issue.team.name}`,
    status: issue.state.name,
    updatedAt: issue.updatedAt,
    source: issue
  }
}
