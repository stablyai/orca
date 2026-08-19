import type { LinearClientForWorkspace } from './client'
import { runLinearProjectRead, type LinearProjectRawVariables } from './project-agent-request'

export type LinearProjectConnectionField = 'members' | 'teams' | 'labels'

export type LinearProjectRawConnection<TNode> = {
  nodes?: TNode[] | null
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
}

export const PROJECT_MEMBER_FIELDS = `
  id
  displayName
  avatarUrl
`

export const PROJECT_TEAM_FIELDS = `
  id
  name
  key
`

export const PROJECT_LABEL_FIELDS = `
  id
  name
  color
  isGroup
  parent {
    id
    name
  }
`

const PROJECT_CONNECTION_PAGE_SIZE = 50

const PROJECT_CONNECTION_QUERIES: Record<LinearProjectConnectionField, string> = {
  members: connectionPageQuery('OrcaLinearProjectMemberPage', 'members', PROJECT_MEMBER_FIELDS),
  teams: connectionPageQuery('OrcaLinearProjectTeamPage', 'teams', PROJECT_TEAM_FIELDS),
  labels: connectionPageQuery('OrcaLinearProjectLabelPage', 'labels', PROJECT_LABEL_FIELDS)
}

function connectionPageQuery(operation: string, field: string, selection: string): string {
  return `
  query ${operation}($id: String!, $first: Int!, $after: String) {
    project(id: $id) {
      ${field}(first: $first, after: $after) {
        nodes { ${selection} }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`
}

type ProjectConnectionPageResponse<TNode> = {
  project?: Record<string, LinearProjectRawConnection<TNode> | null | undefined> | null
}

/**
 * Seeds from the connection already returned by the show query and follows its
 * cursor to the end, so set digests cover every id rather than the first page.
 */
export async function readProjectConnectionRows<TNode, TRow>(args: {
  entry: LinearClientForWorkspace
  projectId: string
  field: LinearProjectConnectionField
  initial: LinearProjectRawConnection<TNode> | null | undefined
  map: (node: TNode) => TRow
  signal?: AbortSignal
}): Promise<TRow[]> {
  const rows = (args.initial?.nodes ?? []).map(args.map)
  let after = args.initial?.pageInfo?.endCursor ?? undefined
  let hasNextPage = args.initial?.pageInfo?.hasNextPage === true

  while (hasNextPage && after) {
    const cursor = after
    const connection = await runLinearProjectRead(args.entry, args.signal, async (client) => {
      const result = await client.client.rawRequest<
        ProjectConnectionPageResponse<TNode>,
        LinearProjectRawVariables
      >(PROJECT_CONNECTION_QUERIES[args.field], {
        id: args.projectId,
        first: PROJECT_CONNECTION_PAGE_SIZE,
        after: cursor
      })
      return result.data?.project?.[args.field]
    })
    const nodes = connection?.nodes ?? []
    rows.push(...nodes.map(args.map))

    const nextCursor = connection?.pageInfo?.endCursor ?? undefined
    // Why: cursor-equality and empty-page guards keep a misbehaving connection from looping forever.
    if (!nextCursor || nextCursor === cursor || nodes.length === 0) {
      break
    }
    hasNextPage = connection?.pageInfo?.hasNextPage === true
    after = nextCursor
  }

  return rows
}
