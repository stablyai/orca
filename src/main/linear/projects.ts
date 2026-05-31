/* eslint-disable max-lines -- Why: Linear project and custom-view reads share
   raw GraphQL selection sets, workspace fan-out, and partial-failure mapping. */
import type {
  LinearCollectionResult,
  LinearConcreteWorkspaceId,
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearIssue,
  LinearProjectDetail,
  LinearProjectMemberSummary,
  LinearProjectSummary,
  LinearWorkspaceError,
  LinearWorkspaceSelection
} from '../../shared/types'
import {
  acquire,
  clearToken,
  getClients,
  isAuthError,
  release,
  type LinearClientForWorkspace
} from './client'

type LinearRawVariables = Record<string, unknown>

type PageInfoNode = {
  hasNextPage?: boolean | null
}

type LinearConnection<T> = {
  nodes?: T[] | null
  pageInfo?: PageInfoNode | null
}

type LinearUserNode = {
  id: string
  displayName?: string | null
  avatarUrl?: string | null
}

type LinearProjectNode = {
  id: string
  name: string
  description?: string | null
  content?: string | null
  url?: string | null
  color?: string | null
  icon?: string | null
  health?: string | null
  priority?: number | null
  priorityLabel?: string | null
  progress?: number | null
  scope?: number | null
  issueCountHistory?: number[] | null
  completedIssueCountHistory?: number[] | null
  startDate?: string | null
  targetDate?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
  canceledAt?: string | null
  startedAt?: string | null
  status?: {
    id: string
    name?: string | null
    type?: string | null
    color?: string | null
  } | null
  lead?: LinearUserNode | null
  members?: LinearConnection<LinearUserNode> | null
  teams?: LinearConnection<{ id: string; name?: string | null; key?: string | null }> | null
  labels?: LinearConnection<{ id: string; name?: string | null; color?: string | null }> | null
  projectMilestones?: LinearConnection<{
    id: string
    name?: string | null
    status?: string | null
    targetDate?: string | null
    progress?: number | null
  }> | null
  externalLinks?: LinearConnection<{
    id: string
    label?: string | null
    url?: string | null
  }> | null
  lastUpdate?: {
    id: string
    body?: string | null
    health?: string | null
    url?: string | null
    createdAt?: string | null
    updatedAt?: string | null
    user?: LinearUserNode | null
  } | null
}

type LinearIssueNode = {
  id: string
  identifier: string
  title: string
  description?: string | null
  url: string
  estimate?: number | null
  priority: number
  updatedAt: string
  labelIds?: string[] | null
  state?: {
    name?: string | null
    type?: string | null
    color?: string | null
  } | null
  team?: {
    id?: string | null
    name?: string | null
    key?: string | null
  } | null
  assignee?: LinearUserNode | null
  labels?: LinearConnection<{ id: string; name: string }> | null
}

type LinearCustomViewNode = {
  id: string
  name: string
  description?: string | null
  modelName?: string | null
  color?: string | null
  icon?: string | null
  shared?: boolean | null
  slugId?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  team?: { id: string; name?: string | null; key?: string | null } | null
  owner?: LinearUserNode | null
  creator?: LinearUserNode | null
}

type ProjectConnectionResponse = {
  projects?: LinearConnection<LinearProjectNode> | null
  searchProjects?: LinearConnection<LinearProjectNode> | null
  project?: LinearProjectNode | null
}

type ProjectIssueConnectionResponse = {
  project?: {
    issues?: LinearConnection<LinearIssueNode> | null
  } | null
}

type CustomViewConnectionResponse = {
  customViews?: LinearConnection<LinearCustomViewNode> | null
  customView?:
    | (LinearCustomViewNode & {
        issues?: LinearConnection<LinearIssueNode> | null
        projects?: LinearConnection<LinearProjectNode> | null
      })
    | null
}

const ORCA_PROJECT_FIELDS = `
  id
  name
  description
  content
  url
  color
  icon
  health
  priority
  priorityLabel
  progress
  scope
  issueCountHistory
  completedIssueCountHistory
  startDate
  targetDate
  createdAt
  updatedAt
  completedAt
  canceledAt
  startedAt
  status {
    id
    name
    type
    color
  }
  lead {
    id
    displayName
    avatarUrl
  }
  members(first: 10) {
    nodes {
      id
      displayName
      avatarUrl
    }
  }
  teams(first: 10) {
    nodes {
      id
      name
      key
    }
  }
  labels(first: 20) {
    nodes {
      id
      name
      color
    }
  }
`

const ORCA_PROJECT_DETAIL_FIELDS = `
  ${ORCA_PROJECT_FIELDS}
  projectMilestones(first: 20) {
    nodes {
      id
      name
      status
      targetDate
      progress
    }
  }
  externalLinks(first: 20) {
    nodes {
      id
      label
      url
    }
  }
  lastUpdate {
    id
    body
    health
    url
    createdAt
    updatedAt
    user {
      id
      displayName
      avatarUrl
    }
  }
`

const ORCA_ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  estimate
  updatedAt
  labelIds
  state {
    name
    type
    color
  }
  team {
    id
    name
    key
  }
  assignee {
    id
    displayName
    avatarUrl
  }
  labels(first: 50) {
    nodes {
      id
      name
    }
  }
`

const PROJECTS_QUERY = `
  query OrcaLinearProjects($first: Int, $filter: ProjectFilter, $orderBy: PaginationOrderBy) {
    projects(first: $first, filter: $filter, orderBy: $orderBy) {
      nodes {
        ${ORCA_PROJECT_FIELDS}
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`

const SEARCH_PROJECTS_QUERY = `
  query OrcaLinearProjectSearch($term: String!, $first: Int) {
    searchProjects(term: $term, first: $first) {
      nodes {
        ${ORCA_PROJECT_FIELDS}
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`

const PROJECT_QUERY = `
  query OrcaLinearProject($id: String!) {
    project(id: $id) {
      ${ORCA_PROJECT_DETAIL_FIELDS}
    }
  }
`

const PROJECT_ISSUES_QUERY = `
  query OrcaLinearProjectIssues($id: String!, $first: Int, $orderBy: PaginationOrderBy) {
    project(id: $id) {
      issues(first: $first, orderBy: $orderBy) {
        nodes {
          ${ORCA_ISSUE_FIELDS}
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`

const CUSTOM_VIEWS_QUERY = `
  query OrcaLinearCustomViews(
    $first: Int,
    $filter: CustomViewFilter,
    $orderBy: PaginationOrderBy
  ) {
    customViews(first: $first, filter: $filter, orderBy: $orderBy) {
      nodes {
        id
        name
        description
        modelName
        color
        icon
        shared
        slugId
        createdAt
        updatedAt
        team {
          id
          name
          key
        }
        owner {
          id
          displayName
          avatarUrl
        }
        creator {
          id
          displayName
          avatarUrl
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`

const CUSTOM_VIEW_QUERY = `
  query OrcaLinearCustomView($id: String!) {
    customView(id: $id) {
      id
      name
      description
      modelName
      color
      icon
      shared
      slugId
      createdAt
      updatedAt
      team {
        id
        name
        key
      }
      owner {
        id
        displayName
        avatarUrl
      }
      creator {
        id
        displayName
        avatarUrl
      }
    }
  }
`

const CUSTOM_VIEW_ISSUES_QUERY = `
  query OrcaLinearCustomViewIssues($id: String!, $first: Int, $orderBy: PaginationOrderBy) {
    customView(id: $id) {
      id
      modelName
      issues(first: $first, orderBy: $orderBy) {
        nodes {
          ${ORCA_ISSUE_FIELDS}
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`

const CUSTOM_VIEW_PROJECTS_QUERY = `
  query OrcaLinearCustomViewProjects($id: String!, $first: Int, $orderBy: PaginationOrderBy) {
    customView(id: $id) {
      id
      modelName
      projects(first: $first, orderBy: $orderBy) {
        nodes {
          ${ORCA_PROJECT_FIELDS}
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`

const inFlight = new Map<string, Promise<unknown>>()

function clampLimit(limit = 20): number {
  return Math.min(Math.max(1, Math.floor(limit)), 50)
}

function coalesce<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined
  if (existing) {
    return existing
  }
  const promise = load().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

function normalizeConcreteWorkspaceId(workspaceId: unknown): LinearConcreteWorkspaceId {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId === 'all') {
    throw new Error('Concrete Linear workspace ID is required')
  }
  return workspaceId.trim()
}

function workspaceError(entry: LinearClientForWorkspace, error: unknown): LinearWorkspaceError {
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

function shouldFailWholeRequest(selection: LinearWorkspaceSelection | null | undefined): boolean {
  return selection !== 'all'
}

function lastNumericValue(values?: number[] | null): number | undefined {
  const last = values?.at(-1)
  return typeof last === 'number' ? last : undefined
}

function mapUser(user?: LinearUserNode | null): LinearProjectMemberSummary | undefined {
  if (!user?.id) {
    return undefined
  }
  return {
    id: user.id,
    displayName: user.displayName ?? '',
    avatarUrl: user.avatarUrl ?? undefined
  }
}

function mapProjectForWorkspace(
  entry: LinearClientForWorkspace,
  project: LinearProjectNode
): LinearProjectSummary {
  return {
    id: project.id,
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

function mapProjectDetailForWorkspace(
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

function mapIssueForWorkspace(
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

function mapCustomViewModel(modelName?: string | null): LinearCustomViewModel | null {
  const normalized = modelName?.toLowerCase()
  if (normalized === 'issue') {
    return 'issue'
  }
  if (normalized === 'project') {
    return 'project'
  }
  return null
}

function mapCustomViewForWorkspace(
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

async function readCollection<T>(
  key: string,
  workspaceId: LinearWorkspaceSelection | null | undefined,
  load: (entry: LinearClientForWorkspace) => Promise<LinearCollectionResult<T>>
): Promise<LinearCollectionResult<T>> {
  return coalesce(key, async () => {
    const entries = getClients(workspaceId)
    if (entries.length === 0) {
      return { items: [] }
    }

    const results = await Promise.all(
      entries.map(async (entry) => {
        await acquire()
        try {
          return await load(entry)
        } catch (error) {
          if (isAuthError(error)) {
            clearToken(entry.workspace.id)
          } else {
            console.warn('[linear] project/view read failed:', error)
          }
          if (shouldFailWholeRequest(workspaceId)) {
            throw error
          }
          return { items: [], errors: [workspaceError(entry, error)] }
        } finally {
          release()
        }
      })
    )

    return {
      items: results.flatMap((result) => result.items),
      errors: results.flatMap((result) => result.errors ?? []).length
        ? results.flatMap((result) => result.errors ?? [])
        : undefined,
      hasMore: results.some((result) => result.hasMore)
    }
  })
}

async function readConcreteCollection<T>(
  key: string,
  workspaceId: LinearConcreteWorkspaceId,
  load: (entry: LinearClientForWorkspace) => Promise<LinearCollectionResult<T>>
): Promise<LinearCollectionResult<T>> {
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readCollection(key, concreteWorkspaceId, load)
}

export async function listProjects(
  query: string | undefined,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  const first = clampLimit(limit)
  const trimmed = query?.trim()
  const key = `listProjects:${workspaceId ?? 'default'}:${trimmed ?? ''}:${first}`
  return readCollection(key, workspaceId, async (entry) => {
    const variables = trimmed ? { term: trimmed, first } : { first, orderBy: 'updatedAt' }
    const result = await entry.client.client.rawRequest<
      ProjectConnectionResponse,
      LinearRawVariables
    >(trimmed ? SEARCH_PROJECTS_QUERY : PROJECTS_QUERY, variables)
    const connection = trimmed ? result.data?.searchProjects : result.data?.projects
    return {
      items: (connection?.nodes ?? []).map((project) => mapProjectForWorkspace(entry, project)),
      hasMore: !!connection?.pageInfo?.hasNextPage
    }
  })
}

export async function getProject(
  id: string,
  workspaceId: LinearConcreteWorkspaceId
): Promise<LinearProjectDetail | null> {
  const projectId = id.trim()
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  if (!projectId) {
    throw new Error('Project ID is required')
  }
  const key = `getProject:${concreteWorkspaceId}:${projectId}`
  return coalesce(key, async () => {
    const entries = getClients(concreteWorkspaceId)
    const entry = entries[0]
    if (!entry) {
      return null
    }
    await acquire()
    try {
      const result = await entry.client.client.rawRequest<
        ProjectConnectionResponse,
        LinearRawVariables
      >(PROJECT_QUERY, { id: projectId })
      return result.data?.project ? mapProjectDetailForWorkspace(entry, result.data.project) : null
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
      }
      throw error
    } finally {
      release()
    }
  })
}

export async function listProjectIssues(
  projectId: string,
  limit = 20,
  workspaceId: LinearConcreteWorkspaceId
): Promise<LinearCollectionResult<LinearIssue>> {
  const id = projectId.trim()
  if (!id) {
    throw new Error('Project ID is required')
  }
  const first = clampLimit(limit)
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readConcreteCollection(
    `listProjectIssues:${concreteWorkspaceId}:${id}:${first}`,
    concreteWorkspaceId,
    async (entry) => {
      const result = await entry.client.client.rawRequest<
        ProjectIssueConnectionResponse,
        LinearRawVariables
      >(PROJECT_ISSUES_QUERY, { id, first, orderBy: 'updatedAt' })
      const project = result.data?.project
      if (!project) {
        throw new Error('Project was not found')
      }
      const connection = project.issues
      return {
        items: (connection?.nodes ?? []).map((issue) => mapIssueForWorkspace(entry, issue)),
        hasMore: !!connection?.pageInfo?.hasNextPage
      }
    }
  )
}

export async function listCustomViews(
  model: LinearCustomViewModel,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearCollectionResult<LinearCustomViewSummary>> {
  const first = clampLimit(limit)
  const key = `listCustomViews:${workspaceId ?? 'default'}:${model}:${first}`
  const filter = { modelName: { eq: model === 'project' ? 'Project' : 'Issue' } }
  return readCollection(key, workspaceId, async (entry) => {
    const result = await entry.client.client.rawRequest<
      CustomViewConnectionResponse,
      LinearRawVariables
    >(CUSTOM_VIEWS_QUERY, { first, filter, orderBy: 'updatedAt' })
    const connection = result.data?.customViews
    return {
      items: (connection?.nodes ?? [])
        .map((view) => mapCustomViewForWorkspace(entry, view))
        .filter((view): view is LinearCustomViewSummary => !!view && view.model === model),
      hasMore: !!connection?.pageInfo?.hasNextPage
    }
  })
}

export async function getCustomView(
  viewId: string,
  model: LinearCustomViewModel,
  workspaceId: LinearConcreteWorkspaceId
): Promise<LinearCustomViewSummary | null> {
  const id = viewId.trim()
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  if (!id) {
    throw new Error('Custom view ID is required')
  }
  const key = `getCustomView:${concreteWorkspaceId}:${model}:${id}`
  return coalesce(key, async () => {
    const entries = getClients(concreteWorkspaceId)
    const entry = entries[0]
    if (!entry) {
      return null
    }
    await acquire()
    try {
      const result = await entry.client.client.rawRequest<
        CustomViewConnectionResponse,
        LinearRawVariables
      >(CUSTOM_VIEW_QUERY, { id })
      const view = result.data?.customView
      const mapped = view ? mapCustomViewForWorkspace(entry, view) : null
      return mapped?.model === model ? mapped : null
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
      }
      throw error
    } finally {
      release()
    }
  })
}

export async function listCustomViewIssues(
  viewId: string,
  limit = 20,
  workspaceId: LinearConcreteWorkspaceId
): Promise<LinearCollectionResult<LinearIssue>> {
  const id = viewId.trim()
  if (!id) {
    throw new Error('Custom view ID is required')
  }
  const first = clampLimit(limit)
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readConcreteCollection(
    `listCustomViewIssues:${concreteWorkspaceId}:${id}:${first}`,
    concreteWorkspaceId,
    async (entry) => {
      const result = await entry.client.client.rawRequest<
        CustomViewConnectionResponse,
        LinearRawVariables
      >(CUSTOM_VIEW_ISSUES_QUERY, { id, first, orderBy: 'updatedAt' })
      const view = result.data?.customView
      if (mapCustomViewModel(view?.modelName) !== 'issue') {
        throw new Error('Custom view does not contain issues')
      }
      const connection = view?.issues
      return {
        items: (connection?.nodes ?? []).map((issue) => mapIssueForWorkspace(entry, issue)),
        hasMore: !!connection?.pageInfo?.hasNextPage
      }
    }
  )
}

export async function listCustomViewProjects(
  viewId: string,
  limit = 20,
  workspaceId: LinearConcreteWorkspaceId
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  const id = viewId.trim()
  if (!id) {
    throw new Error('Custom view ID is required')
  }
  const first = clampLimit(limit)
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readConcreteCollection(
    `listCustomViewProjects:${concreteWorkspaceId}:${id}:${first}`,
    concreteWorkspaceId,
    async (entry) => {
      const result = await entry.client.client.rawRequest<
        CustomViewConnectionResponse,
        LinearRawVariables
      >(CUSTOM_VIEW_PROJECTS_QUERY, { id, first, orderBy: 'updatedAt' })
      const view = result.data?.customView
      if (mapCustomViewModel(view?.modelName) !== 'project') {
        throw new Error('Custom view does not contain projects')
      }
      const connection = view?.projects
      return {
        items: (connection?.nodes ?? []).map((project) => mapProjectForWorkspace(entry, project)),
        hasMore: !!connection?.pageInfo?.hasNextPage
      }
    }
  )
}
