import type { ClickUpTask } from '../../../src/shared/clickup-types'
import type { LinearMobileIssue } from './linear-mobile-issue-read'

export type GitHubAssignableUser = {
  login: string
  name?: string | null
  avatarUrl?: string | null
}

export type GitHubPRReviewSummary = {
  login: string
  state?: string | null
  avatarUrl?: string | null
}

export type GitHubPRCheckSummary = {
  state: 'success' | 'failure' | 'pending' | 'none'
  total: number
  passed: number
  failed: number
  pending: number
}

export type GitHubPRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export type GitHubWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  repoId: string
  repoName: string
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  checksSummary?: GitHubPRCheckSummary
  mergeable?: GitHubPRMergeableState
  mergeStateStatus?: string | null
}

export type GitLabWorkItem = {
  id: string
  type: 'issue' | 'mr'
  number: number
  title: string
  state: 'opened' | 'closed' | 'merged' | 'locked' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  projectRef?: { host: string; path: string }
  repoId: string
  repoName: string
}

export type GitLabTodo = {
  id: number
  actionName: string
  targetType: string
  targetIid: number | null
  targetTitle: string
  targetUrl: string
  projectPath: string
  authorUsername: string
  updatedAt: string
  state: 'pending' | 'done'
}

export type TaskItem =
  | {
      key: string
      provider: 'github'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitHubWorkItem
    }
  | {
      key: string
      provider: 'gitlab'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabWorkItem
    }
  | {
      key: string
      provider: 'gitlabTodo'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: GitLabTodo
    }
  | {
      key: string
      provider: 'linear'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: LinearMobileIssue
    }
  | {
      key: string
      provider: 'clickup'
      title: string
      subtitle: string
      status: string
      updatedAt: string
      source: ClickUpTask
    }

export type ActionableTaskItem = Exclude<TaskItem, { provider: 'gitlabTodo' }>

type TaskRepoIdentity = {
  id: string
  displayName: string
}

function gitHubStatusLabel(item: GitHubWorkItem): string {
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

export function createGitHubTask(
  repo: TaskRepoIdentity,
  item: Omit<GitHubWorkItem, 'repoId' | 'repoName'>
): Extract<TaskItem, { provider: 'github' }> {
  const source: GitHubWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `github:${repo.id}:${item.type}:${item.number}`,
    provider: 'github',
    title: item.title,
    subtitle: `${source.repoName} #${source.number}`,
    status: gitHubStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

function gitLabStatusLabel(item: GitLabWorkItem): string {
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
  repo: TaskRepoIdentity,
  item: Omit<GitLabWorkItem, 'repoId' | 'repoName'>
): Extract<TaskItem, { provider: 'gitlab' }> {
  const source: GitLabWorkItem = { ...item, repoId: repo.id, repoName: repo.displayName }
  return {
    key: `gitlab:${repo.id}:${item.type}:${item.number}`,
    provider: 'gitlab',
    title: item.title,
    subtitle: `${repo.displayName} ${item.type === 'mr' ? '!' : '#'}${item.number}`,
    status: gitLabStatusLabel(source),
    updatedAt: item.updatedAt,
    source
  }
}

function gitLabTodoTargetLabel(todo: Pick<GitLabTodo, 'targetType'>): string {
  if (todo.targetType === 'MergeRequest') {
    return 'Merge request'
  }
  return todo.targetType === 'Issue' ? 'Issue' : 'GitLab todo'
}

function gitLabTodoTargetRef(todo: Pick<GitLabTodo, 'targetType' | 'targetIid'>): string {
  if (!todo.targetIid) {
    return ''
  }
  if (todo.targetType === 'MergeRequest') {
    return `!${todo.targetIid}`
  }
  return todo.targetType === 'Issue' ? `#${todo.targetIid}` : String(todo.targetIid)
}

export function createGitLabTodoTask(
  todo: GitLabTodo
): Extract<TaskItem, { provider: 'gitlabTodo' }> {
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

export function createLinearTask(
  issue: LinearMobileIssue
): Extract<TaskItem, { provider: 'linear' }> {
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

export function createClickUpTask(task: ClickUpTask): Extract<TaskItem, { provider: 'clickup' }> {
  const reference = task.customId ?? task.id
  return {
    key: `clickup:${task.workspaceId}:${task.id}`,
    provider: 'clickup',
    title: task.name,
    subtitle: `${reference} · ${task.list.name}`,
    status: task.status.name,
    updatedAt: task.updatedAt,
    source: task
  }
}

export function taskKindLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return item.source.type === 'pr' ? 'Pull request' : 'Issue'
  }
  if (item.provider === 'gitlab') {
    return item.source.type === 'mr' ? 'Merge request' : 'Issue'
  }
  if (item.provider === 'gitlabTodo') {
    return `${gitLabTodoTargetLabel(item.source)} todo`
  }
  return item.provider === 'linear' ? 'Linear ticket' : 'ClickUp task'
}

export function taskExternalOpenLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return 'Open in GitHub'
  }
  if (item.provider === 'gitlab' || item.provider === 'gitlabTodo') {
    return 'Open in GitLab'
  }
  return item.provider === 'linear' ? 'Open in Linear' : 'Open in ClickUp'
}

export function taskStatusActionLabel(item: TaskItem): string {
  const verb =
    item.provider === 'github' || item.provider === 'gitlab'
      ? item.source.state === 'closed'
        ? 'Reopen'
        : 'Close'
      : ''
  return verb ? `${verb} ${taskKindLabel(item).toLowerCase()}` : ''
}
