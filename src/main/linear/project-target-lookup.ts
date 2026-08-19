import type { LinearClientForWorkspace } from './client'
import {
  isLinearProjectLookupMiss,
  runLinearProjectRead,
  type LinearProjectRawVariables
} from './project-agent-request'

export type LinearProjectTeamRow = { id: string; name: string; key: string }

export type LinearProjectTargetCandidate = {
  id: string
  name: string
  slugId: string
  url: string
  workspaceId: string
  workspaceName: string
  teams: LinearProjectTeamRow[]
}

export type LinearProjectExactMatches = {
  bySlug: LinearProjectTargetCandidate[]
  byName: LinearProjectTargetCandidate[]
  slugHasMore: boolean
  nameHasMore: boolean
}

// Why: candidate errors and the create-path team check both need team context,
// so every target lookup carries a bounded team list.
const PROJECT_TARGET_FIELDS = `
  id
  name
  slugId
  url
  teams(first: 25) {
    nodes {
      id
      name
      key
    }
  }
`

const PROJECT_TARGET_BY_ID_QUERY = `
  query OrcaLinearProjectTargetById($id: String!) {
    project(id: $id) { ${PROJECT_TARGET_FIELDS} }
  }
`

// Why: two rows per exact filter is all it takes to tell zero, one, and many
// apart; `hasNextPage` proves ambiguity without enumerating the connection.
const PROJECT_EXACT_TARGET_QUERY = `
  query OrcaLinearProjectExactTarget($term: String!) {
    bySlug: projects(filter: { slugId: { eqIgnoreCase: $term } }, first: 2) {
      nodes { ${PROJECT_TARGET_FIELDS} }
      pageInfo { hasNextPage }
    }
    byName: projects(filter: { name: { eqIgnoreCase: $term } }, first: 2) {
      nodes { ${PROJECT_TARGET_FIELDS} }
      pageInfo { hasNextPage }
    }
  }
`

type ProjectTargetNode = {
  id: string
  name?: string | null
  slugId?: string | null
  url?: string | null
  teams?: { nodes?: { id: string; name?: string | null; key?: string | null }[] | null } | null
}

type ProjectTargetConnection = {
  nodes?: ProjectTargetNode[] | null
  pageInfo?: { hasNextPage?: boolean | null } | null
}

type ProjectTargetByIdResponse = { project?: ProjectTargetNode | null }
type ProjectExactTargetResponse = {
  bySlug?: ProjectTargetConnection | null
  byName?: ProjectTargetConnection | null
}

export async function lookupLinearProjectById(
  entry: LinearClientForWorkspace,
  id: string,
  signal?: AbortSignal
): Promise<LinearProjectTargetCandidate | null> {
  return await runLinearProjectRead(entry, signal, async (client) => {
    try {
      const result = await client.client.rawRequest<
        ProjectTargetByIdResponse,
        LinearProjectRawVariables
      >(PROJECT_TARGET_BY_ID_QUERY, { id })
      const project = result.data?.project
      return project ? mapProjectTargetCandidate(entry, project) : null
    } catch (error) {
      // Why: a UUID that lives in another workspace throws here; that is a miss, not a failure.
      if (isLinearProjectLookupMiss(error)) {
        return null
      }
      throw error
    }
  })
}

export async function findLinearProjectsByExactTarget(
  entry: LinearClientForWorkspace,
  term: string,
  signal?: AbortSignal
): Promise<LinearProjectExactMatches> {
  return await runLinearProjectRead(entry, signal, async (client) => {
    const result = await client.client.rawRequest<
      ProjectExactTargetResponse,
      LinearProjectRawVariables
    >(PROJECT_EXACT_TARGET_QUERY, { term })
    return {
      bySlug: mapConnection(entry, result.data?.bySlug),
      byName: mapConnection(entry, result.data?.byName),
      slugHasMore: result.data?.bySlug?.pageInfo?.hasNextPage === true,
      nameHasMore: result.data?.byName?.pageInfo?.hasNextPage === true
    }
  })
}

function mapConnection(
  entry: LinearClientForWorkspace,
  connection: ProjectTargetConnection | null | undefined
): LinearProjectTargetCandidate[] {
  return (connection?.nodes ?? []).map((node) => mapProjectTargetCandidate(entry, node))
}

function mapProjectTargetCandidate(
  entry: LinearClientForWorkspace,
  node: ProjectTargetNode
): LinearProjectTargetCandidate {
  return {
    id: node.id,
    name: node.name ?? '',
    slugId: node.slugId ?? '',
    url: node.url ?? '',
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    teams: (node.teams?.nodes ?? []).map((team) => ({
      id: team.id,
      name: team.name ?? '',
      key: team.key ?? ''
    }))
  }
}
