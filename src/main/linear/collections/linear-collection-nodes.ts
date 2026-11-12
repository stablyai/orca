export type LinearRawVariables = Record<string, unknown>

export type PageInfoNode = {
  hasNextPage?: boolean | null
  endCursor?: string | null
}

export type LinearConnection<T> = {
  nodes?: T[] | null
  pageInfo?: PageInfoNode | null
}

export type LinearUserNode = {
  id: string
  displayName?: string | null
  avatarUrl?: string | null
}

export type LinearProjectNode = {
  id: string
  slugId?: string | null
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

export type LinearIssueNode = {
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

export type LinearCustomViewNode = {
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

export type ProjectConnectionResponse = {
  projects?: LinearConnection<LinearProjectNode> | null
  searchProjects?: LinearConnection<LinearProjectNode> | null
  project?: LinearProjectNode | null
}

export type ProjectIssueConnectionResponse = {
  project?: {
    issues?: LinearConnection<LinearIssueNode> | null
  } | null
}

export type ProjectTeamsResponse = {
  project?: {
    teams?: LinearConnection<{ id: string; name?: string | null; key?: string | null }> | null
  } | null
}

export type CustomViewConnectionResponse = {
  customViews?: LinearConnection<LinearCustomViewNode> | null
  customView?:
    | (LinearCustomViewNode & {
        issues?: LinearConnection<LinearIssueNode> | null
        projects?: LinearConnection<LinearProjectNode> | null
      })
    | null
}

export type ProjectMutationResponse = {
  projectCreate?: {
    success?: boolean | null
    project?: LinearProjectNode | null
  } | null
}

export type LinearProjectCreateInput = {
  name: string
  description?: string
  content?: string
  teamIds: string[]
  leadId?: string
  memberIds?: string[]
  labelIds?: string[]
  priority?: number
  startDate?: string
  targetDate?: string
}
