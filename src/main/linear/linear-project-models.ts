import type { LinearIssue } from '../../shared/linear/issue-types'
import type {
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectMemberSummary,
  LinearProjectSummary
} from '../../shared/linear/project-types'
import type {
  LinearConcreteWorkspaceId,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'
import { isAuthError, type LinearClientForWorkspace } from './client'
import type {
  LinearCustomViewNode,
  LinearIssueNode,
  LinearProjectNode,
  LinearUserNode
} from './linear-project-nodes'

const inFlight = new Map<string, Promise<unknown>>()
export const LINEAR_PROJECT_API_PAGE_SIZE_MAX = 50

export function clampLimit(limit = 20): number {
  return Math.min(Math.max(1, Math.floor(limit)), LINEAR_PROJECT_API_PAGE_SIZE_MAX)
}

export function coalesce<T>(key: string, load: () => Promise<T>, force = false): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined
  if (existing && !force) {
    return existing
  }
  const promise = load().finally(() => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key)
    }
  })
  inFlight.set(key, promise)
  return promise
}

export function normalizeConcreteWorkspaceId(workspaceId: unknown): LinearConcreteWorkspaceId {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId === 'all') {
    throw new Error('Concrete Linear workspace ID is required')
  }
  return workspaceId.trim()
}

export function workspaceError(
  entry: LinearClientForWorkspace,
  error: unknown
): LinearWorkspaceError {
  if (isAuthError(error)) {
    return {
      workspaceId: entry.workspace.id,
      workspaceName: entry.workspace.organizationName,
      type: 'auth',
      message: 'Linear authentication expired for this workspace.'
    }
  }

  const record = error as { name?: string; message?: string; status?: number; response?: unknown }
  const message = record.message || 'Linear request failed.'
  const status =
    typeof record.status === 'number'
      ? record.status
      : typeof (record.response as { status?: unknown } | undefined)?.status === 'number'
        ? ((record.response as { status: number }).status as number)
        : undefined
  const name = record.name ?? ''

  if (status === 429 || /rate/i.test(name)) {
    return {
      workspaceId: entry.workspace.id,
      workspaceName: entry.workspace.organizationName,
      type: 'rate_limited',
      message
    }
  }
  if ((typeof status === 'number' && status >= 500) || /network/i.test(name)) {
    return {
      workspaceId: entry.workspace.id,
      workspaceName: entry.workspace.organizationName,
      type: 'network',
      message
    }
  }

  return {
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    type: 'unknown',
    message
  }
}

export function shouldFailWholeRequest(
  selection: LinearWorkspaceSelection | null | undefined
): boolean {
  return selection !== 'all'
}

export function lastNumericValue(values?: number[] | null): number | undefined {
  const last = values?.at(-1)
  return typeof last === 'number' ? last : undefined
}

export function mapUser(user?: LinearUserNode | null): LinearProjectMemberSummary | undefined {
  if (!user?.id) {
    return undefined
  }
  return {
    id: user.id,
    displayName: user.displayName ?? '',
    avatarUrl: user.avatarUrl ?? undefined
  }
}

export function mapProjectForWorkspace(
  entry: LinearClientForWorkspace,
  project: LinearProjectNode
): LinearProjectSummary {
  return {
    id: project.id,
    slugId: project.slugId ?? undefined,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    name: project.name,
    url: project.url ?? undefined,
    color: project.color ?? undefined,
    icon: project.icon ?? undefined,
    description: project.description ?? undefined,
    content: project.content ?? undefined,
    status: project.status
      ? {
          id: project.status.id,
          name: project.status.name ?? '',
          type: project.status.type ?? undefined,
          color: project.status.color ?? undefined
        }
      : undefined,
    health: project.health ?? null,
    priority: project.priority ?? null,
    priorityLabel: project.priorityLabel ?? null,
    lead: mapUser(project.lead),
    members: project.members?.nodes
      ?.map(mapUser)
      .filter((user): user is LinearProjectMemberSummary => !!user),
    teams: project.teams?.nodes?.map((team) => ({
      id: team.id,
      name: team.name ?? '',
      key: team.key ?? undefined
    })),
    labels: project.labels?.nodes?.map((label) => ({
      id: label.id,
      name: label.name ?? '',
      color: label.color ?? undefined
    })),
    startDate: project.startDate ?? null,
    targetDate: project.targetDate ?? null,
    createdAt: project.createdAt ?? undefined,
    updatedAt: project.updatedAt ?? undefined,
    completedAt: project.completedAt ?? null,
    canceledAt: project.canceledAt ?? null,
    startedAt: project.startedAt ?? null,
    progress: project.progress ?? null,
    scope: project.scope ?? null,
    issueCount: lastNumericValue(project.issueCountHistory),
    completedIssueCount: lastNumericValue(project.completedIssueCountHistory)
  }
}

export function mapProjectDetailForWorkspace(
  entry: LinearClientForWorkspace,
  project: LinearProjectNode
): LinearProjectDetail {
  return {
    ...mapProjectForWorkspace(entry, project),
    milestones: project.projectMilestones?.nodes?.map((milestone) => ({
      id: milestone.id,
      name: milestone.name ?? '',
      status: milestone.status ?? undefined,
      targetDate: milestone.targetDate ?? null,
      progress: milestone.progress ?? null
    })),
    resources: project.externalLinks?.nodes
      ?.filter((link) => link.url)
      .map((link) => ({
        id: link.id,
        title: link.label || link.url || 'Link',
        url: link.url!,
        type: 'link'
      })),
    latestUpdate: project.lastUpdate
      ? {
          id: project.lastUpdate.id,
          body: project.lastUpdate.body ?? undefined,
          health: project.lastUpdate.health ?? null,
          url: project.lastUpdate.url ?? undefined,
          createdAt: project.lastUpdate.createdAt ?? undefined,
          updatedAt: project.lastUpdate.updatedAt ?? undefined,
          user: mapUser(project.lastUpdate.user)
        }
      : undefined
  }
}

export function mapIssueForWorkspace(
  entry: LinearClientForWorkspace,
  issue: LinearIssueNode
): LinearIssue {
  const labelNodes = issue.labels?.nodes ?? []
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    url: issue.url,
    state: {
      name: issue.state?.name ?? '',
      type: issue.state?.type ?? '',
      color: issue.state?.color ?? ''
    },
    team: {
      id: issue.team?.id ?? '',
      name: issue.team?.name ?? '',
      key: issue.team?.key ?? ''
    },
    labels: labelNodes.map((label) => label.name),
    labelIds: issue.labelIds ?? labelNodes.map((label) => label.id),
    assignee: mapUser(issue.assignee),
    estimate: issue.estimate ?? null,
    priority: issue.priority,
    updatedAt: issue.updatedAt,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName
  }
}

export function mapCustomViewModel(modelName?: string | null): LinearCustomViewModel | null {
  const normalized = modelName?.toLowerCase()
  if (normalized === 'issue') {
    return 'issue'
  }
  if (normalized === 'project') {
    return 'project'
  }
  return null
}

export function mapCustomViewForWorkspace(
  entry: LinearClientForWorkspace,
  view: LinearCustomViewNode
): LinearCustomViewSummary | null {
  const model = mapCustomViewModel(view.modelName)
  if (!model) {
    return null
  }
  return {
    id: view.id,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    name: view.name,
    description: view.description ?? undefined,
    model,
    url: view.slugId
      ? `https://linear.app/${entry.workspace.organizationUrlKey}/view/${view.slugId}`
      : undefined,
    color: view.color ?? undefined,
    icon: view.icon ?? undefined,
    shared: view.shared ?? undefined,
    team: view.team
      ? {
          id: view.team.id,
          name: view.team.name ?? undefined,
          key: view.team.key ?? undefined
        }
      : undefined,
    owner: mapUser(view.owner),
    creator: mapUser(view.creator),
    createdAt: view.createdAt ?? undefined,
    updatedAt: view.updatedAt ?? undefined
  }
}
