import type { LinearIssueAttributeFilter } from '../../shared/linear/issue-attribute-filter'
import type { LinearIssueWriteRecord } from './linear-issue-write-support'

export type LinearIssueListOptions = {
  teamId?: string
  attributeFilter?: LinearIssueAttributeFilter | null
}

export type LinearIssueNode = {
  id: string
  identifier: string
  title: string
  branchName?: string | null
  description?: string | null
  url: string
  dueDate?: string | null
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
  assignee?: {
    id: string
    displayName: string
    avatarUrl?: string | null
  } | null
  labels?: {
    nodes?: { id: string; name: string }[]
  } | null
}

export type LinearIssueConnectionResponse = {
  searchIssues?: { nodes?: LinearIssueNode[] }
  issues?: LinearIssueConnection
  viewer?: {
    assignedIssues?: LinearIssueConnection
    createdIssues?: LinearIssueConnection
  }
}

export type LinearIssueConnection = {
  nodes?: LinearIssueNode[]
  pageInfo?: {
    hasNextPage?: boolean
    endCursor?: string | null
  }
}

export type LinearRawVariables = Record<string, unknown>
export type LinearIssuePageRequest = {
  first: number
  after?: string
}
export type LinearIssueConnectionLoader = (
  page: LinearIssuePageRequest
) => Promise<LinearIssueConnection | null | undefined>
export const LINEAR_ISSUE_NODE_FIELDS = `
  id
  identifier
  title
  branchName
  description
  url
  dueDate
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

export const SEARCH_ISSUES_QUERY = `
  query OrcaLinearIssueSearch($term: String!, $first: Int) {
    searchIssues(term: $term, first: $first) {
      nodes {
        ${LINEAR_ISSUE_NODE_FIELDS}
      }
    }
  }
`

export const ALL_ISSUES_QUERY = `
  query OrcaLinearIssues(
    $first: Int,
    $after: String,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
      nodes {
        ${LINEAR_ISSUE_NODE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

export const VIEWER_ASSIGNED_ISSUES_QUERY = `
  query OrcaLinearViewerAssignedIssues(
    $first: Int,
    $after: String,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    viewer {
      assignedIssues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
        nodes {
          ${LINEAR_ISSUE_NODE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

export const VIEWER_CREATED_ISSUES_QUERY = `
  query OrcaLinearViewerCreatedIssues(
    $first: Int,
    $after: String,
    $filter: IssueFilter,
    $orderBy: PaginationOrderBy
  ) {
    viewer {
      createdIssues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
        nodes {
          ${LINEAR_ISSUE_NODE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

export const AGENT_ISSUE_WRITE_FIELDS = `
  id
  identifier
  title
  description
  url
  team { id key name }
  state { id name }
  parent { id identifier }
  project { id name }
  assignee { id displayName }
  priority
  estimate
  dueDate
  labelIds
  labels(first: 50) { nodes { id name } }
`

export const ISSUE_BY_UUID_QUERY = `
  query OrcaLinearIssueByUuid($id: String!) {
    issue(id: $id) {
      ${AGENT_ISSUE_WRITE_FIELDS}
    }
  }
`

export const COMMENT_BY_UUID_QUERY = `
  query OrcaLinearCommentByUuid($id: String!) {
    comment(id: $id) {
      id
      url
      body
      parent { id }
      issue { id identifier url }
    }
  }
`

export const ATTACHMENT_BY_UUID_QUERY = `
  query OrcaLinearAttachmentByUuid($id: String!) {
    attachment(id: $id) {
      id
      title
      url
      issue { id identifier url }
    }
  }
`

// Why: fetch comments with their author in a single request. Accessing
// `.user` on the SDK's Comment model lazily issues one user(id) query per
// comment, so the previous loop was an N+1 (issue + comments + N user
// fetches, all sequential while holding a shared Linear concurrency slot).
// first: 50 matches the SDK default page size the previous code relied on.
export const ISSUE_COMMENTS_QUERY = `
  query OrcaLinearIssueComments($id: String!) {
    issue(id: $id) {
      comments(first: 50) {
        nodes {
          id
          body
          createdAt
          user {
            displayName
            avatarUrl
          }
        }
      }
    }
  }
`

export type LinearIssueByUuidResponse = {
  issue?:
    | (Omit<LinearIssueWriteRecord, 'labels'> & {
        labels?: { nodes?: { id: string; name: string }[] } | null
      })
    | null
}

export type LinearCommentByUuidResponse = {
  comment?: {
    id: string
    url?: string | null
    body?: string | null
    parent?: { id?: string | null } | null
    issue?: { id?: string | null; identifier?: string | null; url?: string | null } | null
  } | null
}

export type LinearAttachmentByUuidResponse = {
  attachment?: {
    id: string
    title?: string | null
    url?: string | null
    issue?: { id?: string | null; identifier?: string | null; url?: string | null } | null
  } | null
}

export type LinearIssueCommentsResponse = {
  issue?: {
    comments?: {
      nodes?:
        | {
            id: string
            body?: string | null
            createdAt?: string | null
            user?: { displayName?: string | null; avatarUrl?: string | null } | null
          }[]
        | null
    } | null
  } | null
}
