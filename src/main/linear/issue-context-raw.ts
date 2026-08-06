import type {
  LinearCollectionMeta,
  LinearIssueSummary,
  LinearSearchIssueSummary
} from '../../shared/linear-agent-access'

export type RawIssueResponse = {
  issue?: RawIssue | null
  searchIssues?: { nodes?: RawIssue[] }
}

export type RawIssue = {
  id: string
  identifier: string
  title: string
  url: string
  description?: string | null
  priority?: number | null
  estimate?: number | null
  dueDate?: string | null
  branchName?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  state?: RawNamedEntity | null
  team?: (RawNamedEntity & { key?: string | null }) | null
  project?: RawNamedEntity | null
  cycle?: RawNamedEntity | null
  assignee?: RawUser | null
  labels?: { nodes?: RawNamedEntity[]; pageInfo?: RawPageInfo } | null
}

export type RawNamedEntity = {
  id?: string | null
  name?: string | null
  color?: string | null
  type?: string | null
}

export type RawUser = {
  id?: string | null
  displayName?: string | null
  avatarUrl?: string | null
}

export type RawPageInfo = {
  hasNextPage?: boolean
  endCursor?: string | null
}

export type RawCommentsResponse = {
  issue?: {
    comments?: {
      nodes?: {
        id: string
        body?: string | null
        createdAt?: string | null
        updatedAt?: string | null
        parent?: { id?: string | null } | null
        user?: RawUser | null
      }[]
      pageInfo?: RawPageInfo
    } | null
  } | null
}

export type RawChildrenResponse = {
  issue?: {
    children?: {
      nodes?: RawIssue[]
      pageInfo?: RawPageInfo
    } | null
  } | null
}

export type RawAttachmentsResponse = {
  issue?: {
    attachments?: {
      nodes?: {
        id: string
        title?: string | null
        url?: string | null
        source?: string | null
        subtitle?: string | null
        createdAt?: string | null
      }[]
      pageInfo?: RawPageInfo
    } | null
  } | null
}

export type RawRelationNode = {
  id: string
  type?: string | null
  issue?: RawIssue | null
  relatedIssue?: RawIssue | null
}

export type RawRelationsResponse = {
  issue?: {
    relations?: {
      nodes?: RawRelationNode[]
      pageInfo?: RawPageInfo
    } | null
    inverseRelations?: {
      nodes?: RawRelationNode[]
      pageInfo?: RawPageInfo
    } | null
  } | null
}

export const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  description
  priority
  estimate
  dueDate
  branchName
  createdAt
  updatedAt
  state { id name type color }
  team { id name key color }
  project { id name color }
  cycle { id name }
  assignee { id displayName avatarUrl }
  labels(first: 50) { nodes { id name color } pageInfo { hasNextPage } }
`

export const ISSUE_QUERY = `
  query OrcaAgentLinearIssue($id: String!) {
    issue(id: $id) {
      ${ISSUE_FIELDS}
    }
  }
`

export const SEARCH_QUERY = `
  query OrcaAgentLinearSearch($term: String!, $first: Int) {
    searchIssues(term: $term, first: $first) {
      nodes {
        ${ISSUE_FIELDS}
      }
    }
  }
`

export const COMMENTS_QUERY = `
  query OrcaAgentLinearIssueComments($id: String!, $first: Int, $after: String) {
    issue(id: $id) {
      comments(first: $first, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          parent { id }
          user { id displayName avatarUrl }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

export const CHILDREN_QUERY = `
  query OrcaAgentLinearIssueChildren($id: String!, $first: Int, $after: String) {
    issue(id: $id) {
      children(first: $first, after: $after) {
        nodes {
          ${ISSUE_FIELDS}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

export const ATTACHMENTS_QUERY = `
  query OrcaAgentLinearIssueAttachments($id: String!, $first: Int, $after: String) {
    issue(id: $id) {
      attachments(first: $first, after: $after) {
        nodes { id title url source subtitle createdAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

export const RELATIONS_QUERY = `
  query OrcaAgentLinearIssueRelations($id: String!, $first: Int, $after: String) {
    issue(id: $id) {
      relations(first: $first, after: $after) {
        nodes {
          id
          type
          relatedIssue { id identifier title url }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

export const INVERSE_RELATIONS_QUERY = `
  query OrcaAgentLinearIssueInverseRelations($id: String!, $first: Int, $after: String) {
    issue(id: $id) {
      inverseRelations(first: $first, after: $after) {
        nodes {
          id
          type
          issue { id identifier title url }
          relatedIssue { id identifier title url }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

export function mapIssue(issue: RawIssue): LinearIssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description,
    state: issue.state ?? null,
    team: issue.team ?? null,
    project: issue.project ?? null,
    cycle: issue.cycle ?? null,
    assignee: issue.assignee ?? null,
    labels: issue.labels?.nodes ?? [],
    priority: issue.priority,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    branchName: issue.branchName,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt
  }
}

export function pickSearchIssue(
  issue: LinearIssueSummary
): Omit<LinearSearchIssueSummary, 'workspace'> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    team: issue.team,
    project: issue.project,
    assignee: issue.assignee,
    priority: issue.priority,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    updatedAt: issue.updatedAt
  }
}

export function collectionMeta(
  returned: number,
  cap: number,
  hasMore?: boolean
): LinearCollectionMeta {
  return {
    returned,
    cap,
    capReached: returned >= cap || hasMore === true,
    ...(hasMore !== undefined ? { hasMore } : {})
  }
}
