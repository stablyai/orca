import type { LinearLabel, LinearMember, LinearTeam, LinearWorkflowState } from '../../shared/types'
import { buildLinearTeamUrl } from '../../shared/linear-links'
import type { LinearClientForWorkspace } from './client'

const TEAM_PAGE_SIZE = 100

type LinearConnectionPage<TNode> = {
  nodes: TNode[]
  pageInfo: { hasNextPage: boolean }
  fetchNext: () => Promise<LinearConnectionPage<TNode>>
}

type TeamLabelNode = {
  id: string
  name: string
  color: string
}

type TeamMemberNode = {
  id: string
  displayName: string
  avatarUrl?: string | null
}

type TeamStateNode = {
  id: string
  name: string
  type: string
  color: string
  position: number
}

export async function fetchAllTeamsForWorkspace(
  entry: LinearClientForWorkspace
): Promise<LinearTeam[]> {
  let page = await entry.client.teams({ first: TEAM_PAGE_SIZE })
  while (page.pageInfo.hasNextPage) {
    await page.fetchNext()
  }
  return page.nodes.map((t) => ({
    id: t.id,
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.organizationName,
    name: t.name,
    key: t.key,
    url:
      buildLinearTeamUrl({
        organizationUrlKey: entry.workspace.organizationUrlKey,
        teamKey: t.key
      }) ?? undefined
  }))
}

export async function fetchAllTeamStates(team: {
  states: (variables?: { first?: number }) => Promise<LinearConnectionPage<TeamStateNode>>
}): Promise<LinearWorkflowState[]> {
  const states = await team.states({ first: TEAM_PAGE_SIZE })
  while (states.pageInfo.hasNextPage) {
    await states.fetchNext()
  }
  return states.nodes
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      color: s.color,
      position: s.position
    }))
    .sort((a, b) => a.position - b.position)
}

export async function fetchAllTeamLabels(team: {
  labels: (variables?: { first?: number }) => Promise<LinearConnectionPage<TeamLabelNode>>
}): Promise<LinearLabel[]> {
  const labels = await team.labels({ first: TEAM_PAGE_SIZE })
  while (labels.pageInfo.hasNextPage) {
    await labels.fetchNext()
  }
  return labels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color }))
}

export async function fetchAllTeamMembers(team: {
  members: (variables?: { first?: number }) => Promise<LinearConnectionPage<TeamMemberNode>>
}): Promise<LinearMember[]> {
  const members = await team.members({ first: TEAM_PAGE_SIZE })
  while (members.pageInfo.hasNextPage) {
    await members.fetchNext()
  }
  return members.nodes.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl ?? undefined
  }))
}
