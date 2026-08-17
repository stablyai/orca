import type {
  LinearProjectTeamRef,
  LinearProjectUserRef
} from '../../shared/linear/project-agent-access'
import { isLinearUuid } from '../../shared/linear/uuid'
import type { LinearClientForWorkspace } from './client'
import { linearError } from './issue-context-errors'
import { runLinearProjectRead, type LinearProjectRawVariables } from './project-agent-request'
import { mapLinearProjectTeamRef, mapLinearProjectUserRef } from './project-reference-mapping'
import { selectLinearProjectWorkspaces } from './project-workspace-scope'

const WRITE_ACTION = 'a project write'

// Why: workspace users, not a team's members — project leads and members are workspace-wide.
const WORKSPACE_USER_QUERY = `
  query OrcaLinearWorkspaceUser($filter: UserFilter!) {
    users(filter: $filter, first: 2, includeArchived: false, includeDisabled: false) {
      nodes {
        id
        displayName
        avatarUrl
        archivedAt
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`

const VIEWER_QUERY = `
  query OrcaLinearWorkspaceViewer {
    viewer {
      id
      displayName
      avatarUrl
    }
  }
`

const TEAM_FIELDS = `
      nodes {
        id
        name
        key
        archivedAt
      }
      pageInfo {
        hasNextPage
      }
`

// Why: `includeArchived: false` is explicit so an archived team can never be newly assigned.
const WORKSPACE_TEAM_QUERY = `
  query OrcaLinearWorkspaceTeam($term: String!) {
    byKey: teams(filter: { key: { eqIgnoreCase: $term } }, first: 2, includeArchived: false) {
${TEAM_FIELDS}
    }
    byName: teams(filter: { name: { eqIgnoreCase: $term } }, first: 2, includeArchived: false) {
${TEAM_FIELDS}
    }
  }
`

const WORKSPACE_TEAM_BY_ID_QUERY = `
  query OrcaLinearWorkspaceTeamById($term: ID!) {
    byKey: teams(filter: { id: { eq: $term } }, first: 2, includeArchived: false) {
${TEAM_FIELDS}
    }
  }
`

type UserNode = {
  id: string
  displayName?: string | null
  avatarUrl?: string | null
  archivedAt?: string | null
}
type TeamNode = {
  id: string
  name?: string | null
  key?: string | null
  archivedAt?: string | null
}
type Connection<T> = { nodes?: T[] | null; pageInfo?: { hasNextPage?: boolean | null } | null }

type WorkspaceUserResponse = { users?: Connection<UserNode> | null }
type ViewerResponse = { viewer?: UserNode | null }
type WorkspaceTeamResponse = {
  byKey?: Connection<TeamNode> | null
  byName?: Connection<TeamNode> | null
}

/** `me`, id, email, or unique exact display name among active workspace users. */
export async function resolveWorkspaceUserForWrite(
  input: string,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectUserRef> {
  const entry = writeEntry(workspaceId)
  const term = input.trim()
  if (term.toLowerCase() === 'me') {
    const viewer = await runLinearProjectRead(entry, options.signal, async (client) => {
      const result = await client.client.rawRequest<ViewerResponse, LinearProjectRawVariables>(
        VIEWER_QUERY,
        {}
      )
      return result.data?.viewer ?? null
    })
    if (!viewer) {
      throw userError('The Linear viewer could not be read.')
    }
    return mapLinearProjectUserRef(viewer)
  }

  const connection = await runLinearProjectRead(entry, options.signal, async (client) => {
    const result = await client.client.rawRequest<WorkspaceUserResponse, LinearProjectRawVariables>(
      WORKSPACE_USER_QUERY,
      { filter: { active: { eq: true }, ...userMatchFilter(term) } }
    )
    return result.data?.users
  })
  const nodes = (connection?.nodes ?? []).filter((node) => !node.archivedAt)
  if (nodes.length === 1 && connection?.pageInfo?.hasNextPage !== true) {
    return mapLinearProjectUserRef(nodes[0])
  }
  throw userError(
    nodes.length === 0
      ? `No active Linear user exactly matched "${term}".`
      : `Multiple active Linear users exactly matched "${term}".`,
    nodes
  )
}

/** Team id, key, or unique exact name; archived teams are excluded. */
export async function resolveWorkspaceTeamsForWrite(
  inputs: string[],
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectTeamRef[]> {
  return await resolveWorkspaceTeamsInEntry(writeEntry(workspaceId), inputs, options.signal)
}

/** Entry-scoped variant, so create can try every connected workspace for one team set. */
export async function resolveWorkspaceTeamsInEntry(
  entry: LinearClientForWorkspace,
  inputs: string[],
  signal: AbortSignal | undefined
): Promise<LinearProjectTeamRef[]> {
  const resolved = new Map<string, LinearProjectTeamRef>()
  for (const input of inputs) {
    const team = await resolveOneWorkspaceTeam(entry, input.trim(), signal)
    resolved.set(team.id, team)
  }
  return [...resolved.values()]
}

async function resolveOneWorkspaceTeam(
  entry: LinearClientForWorkspace,
  term: string,
  signal: AbortSignal | undefined
): Promise<LinearProjectTeamRef> {
  const byId = isLinearUuid(term)
  const result = await runLinearProjectRead(entry, signal, async (client) => {
    const response = await client.client.rawRequest<
      WorkspaceTeamResponse,
      LinearProjectRawVariables
    >(byId ? WORKSPACE_TEAM_BY_ID_QUERY : WORKSPACE_TEAM_QUERY, { term })
    return response.data
  })
  const matches = new Map<string, LinearProjectTeamRef>()
  for (const node of [...(result?.byKey?.nodes ?? []), ...(result?.byName?.nodes ?? [])]) {
    if (node.archivedAt || (byId && node.id !== term)) {
      continue
    }
    matches.set(node.id, mapLinearProjectTeamRef(node))
  }
  const ambiguous =
    result?.byKey?.pageInfo?.hasNextPage === true || result?.byName?.pageInfo?.hasNextPage === true
  if (matches.size === 1 && !ambiguous) {
    return [...matches.values()][0]
  }
  throw linearError(
    'linear_team_required',
    matches.size === 0
      ? `No connected Linear team matched ${term}.`
      : `Multiple Linear teams matched ${term}.`,
    {
      teams: [...matches.values()],
      nextSteps: ['Run `orca linear teams --json` and retry with a team key.']
    }
  )
}

function userMatchFilter(term: string): Record<string, unknown> {
  if (isLinearUuid(term)) {
    return { id: { eq: term } }
  }
  if (term.includes('@')) {
    return { email: { eqIgnoreCase: term } }
  }
  return { displayName: { eqIgnoreCase: term } }
}

function userError(message: string, candidates: UserNode[] = []): ReturnType<typeof linearError> {
  return linearError('linear_invalid_assignee', message, {
    users: candidates.map((node) => ({ id: node.id, displayName: node.displayName ?? '' })),
    nextSteps: ['Pass a Linear user id, email, or `me`.']
  })
}

function writeEntry(workspaceId: string): LinearClientForWorkspace {
  return selectLinearProjectWorkspaces(workspaceId, WRITE_ACTION)[0]
}
