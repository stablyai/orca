import {
  PROJECT_LABEL_FIELDS,
  PROJECT_MEMBER_FIELDS,
  PROJECT_TEAM_FIELDS,
  type LinearProjectRawConnection
} from './project-connection-pages'

export type ProjectShowUserNode = {
  id: string
  displayName?: string | null
  avatarUrl?: string | null
}

export type ProjectShowTeamNode = { id: string; name?: string | null; key?: string | null }

export type ProjectShowLabelNode = {
  id: string
  name?: string | null
  color?: string | null
  isGroup?: boolean | null
  parent?: { id: string; name?: string | null } | null
}

export type ProjectShowUpdateNode = {
  id: string
  body?: string | null
  health?: string | null
  url?: string | null
  isDiffHidden?: boolean | null
  isStale?: boolean | null
  createdAt?: string | null
  updatedAt?: string | null
  editedAt?: string | null
  user?: ProjectShowUserNode | null
}

export type ProjectShowNode = {
  id: string
  name?: string | null
  slugId?: string | null
  url?: string | null
  description?: string | null
  content?: string | null
  color?: string | null
  icon?: string | null
  priority?: number | null
  startDate?: string | null
  targetDate?: string | null
  health?: string | null
  healthUpdatedAt?: string | null
  status?: { id: string; name?: string | null; type?: string | null; color?: string | null } | null
  lead?: ProjectShowUserNode | null
  members?: LinearProjectRawConnection<ProjectShowUserNode> | null
  teams?: LinearProjectRawConnection<ProjectShowTeamNode> | null
  labels?: LinearProjectRawConnection<ProjectShowLabelNode> | null
  projectUpdates?: LinearProjectRawConnection<ProjectShowUpdateNode> | null
}

export type ProjectShowResponse = { project?: ProjectShowNode | null }

const PROJECT_CONNECTION_FIRST = 50

const PROJECT_SHOW_FIELDS = `
  id
  name
  slugId
  url
  description
  content
  color
  icon
  priority
  startDate
  targetDate
  health
  healthUpdatedAt
  status {
    id
    name
    type
    color
  }
  lead { ${PROJECT_MEMBER_FIELDS} }
  members(first: ${PROJECT_CONNECTION_FIRST}) {
    nodes { ${PROJECT_MEMBER_FIELDS} }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
  teams(first: ${PROJECT_CONNECTION_FIRST}) {
    nodes { ${PROJECT_TEAM_FIELDS} }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
  labels(first: ${PROJECT_CONNECTION_FIRST}) {
    nodes { ${PROJECT_LABEL_FIELDS} }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`

/** Default read: every editable field plus derived health, and no update bodies. */
export const PROJECT_SHOW_QUERY = `
  query OrcaLinearProjectShow($id: String!) {
    project(id: $id) { ${PROJECT_SHOW_FIELDS} }
  }
`

// Why: projectUpdates takes no filter and PaginationOrderBy carries no direction,
// so the feed is ordered newest-first after the response.
export const PROJECT_SHOW_WITH_UPDATES_QUERY = `
  query OrcaLinearProjectShowWithUpdates($id: String!, $updatesLimit: Int!) {
    project(id: $id) {
      ${PROJECT_SHOW_FIELDS}
      projectUpdates(first: $updatesLimit, orderBy: createdAt) {
        nodes {
          id
          body
          health
          url
          isDiffHidden
          isStale
          createdAt
          updatedAt
          editedAt
          user { ${PROJECT_MEMBER_FIELDS} }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`
