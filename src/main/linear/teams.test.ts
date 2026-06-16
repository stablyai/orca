import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { credentialDecryptionMessage } from '../../shared/integration-credential-errors'

const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args),
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

type TeamNode = {
  id: string
  name: string
  key: string
}

type LabelNode = {
  id: string
  name: string
  color: string
}

type MemberNode = {
  id: string
  displayName: string
  avatarUrl?: string | null
}

type StateNode = {
  id: string
  name: string
  type: string
  color: string
  position: number
}

function team(id: string, name = id, key = id.toUpperCase()): TeamNode {
  return { id, name, key }
}

function makeLabel(id: string, name = id): LabelNode {
  return { id, name, color: '#ff0000' }
}

function makeMember(id: string, displayName = id): MemberNode {
  return { id, displayName, avatarUrl: null }
}

function makeState(id: string, name = id, position = 0): StateNode {
  return { id, name, type: 'started', color: '#00ff00', position }
}

function makeConnection<TNode>(pages: TNode[][]) {
  const nodes = [...(pages[0] ?? [])]
  let pageIndex = 0
  return {
    nodes,
    pageInfo: { hasNextPage: pages.length > 1 },
    fetchNext: vi
      .fn()
      .mockImplementation(
        async function fetchNext(this: { nodes: TNode[]; pageInfo: { hasNextPage: boolean } }) {
          pageIndex += 1
          this.nodes.push(...(pages[pageIndex] ?? []))
          this.pageInfo.hasNextPage = pageIndex < pages.length - 1
          return this
        }
      )
  }
}

function makeEntry(
  workspaceId: string,
  organizationName: string,
  organizationUrlKey: string,
  pages: TeamNode[][]
): LinearClientForWorkspace {
  return {
    workspace: {
      id: workspaceId,
      organizationId: workspaceId,
      organizationName,
      organizationUrlKey,
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      teams: vi.fn().mockResolvedValue(makeConnection(pages))
    }
  } as unknown as LinearClientForWorkspace
}

function makeTeamLookupEntry(
  workspaceId: string,
  organizationName: string,
  teamNode: unknown
): LinearClientForWorkspace {
  return {
    workspace: {
      id: workspaceId,
      organizationId: workspaceId,
      organizationName,
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      team: vi.fn().mockResolvedValue(teamNode)
    }
  } as unknown as LinearClientForWorkspace
}

function makeFailingEntry(
  workspaceId: string,
  organizationName: string,
  error: Error
): LinearClientForWorkspace {
  return {
    workspace: {
      id: workspaceId,
      organizationId: workspaceId,
      organizationName,
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      teams: vi.fn().mockRejectedValue(error)
    }
  } as unknown as LinearClientForWorkspace
}

describe('Linear teams', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthError.mockReturnValue(false)
  })

  it('fetches every page of teams for a workspace', async () => {
    const entry = makeEntry('workspace-1', 'Workspace', 'acme', [
      [team('team-1', 'Backend', 'BE')],
      [team('team-2', 'Frontend', 'FE')],
      [team('team-3', 'Support', 'SUP')]
    ])
    getClients.mockReturnValue([entry])
    const { listTeams } = await import('./teams')

    await expect(listTeams('workspace-1')).resolves.toMatchObject([
      { id: 'team-1', url: 'https://linear.app/acme/team/BE/all' },
      { id: 'team-2', url: 'https://linear.app/acme/team/FE/all' },
      { id: 'team-3', url: 'https://linear.app/acme/team/SUP/all' }
    ])

    expect(entry.client.teams).toHaveBeenCalledWith({ first: 100 })
  })

  it('aggregates teams across all selected workspaces', async () => {
    getClients.mockReturnValue([
      makeEntry('workspace-1', 'Alpha', 'alpha', [[team('team-a', 'Alpha Team', 'ALP')]]),
      makeEntry('workspace-2', 'Beta', 'beta', [[team('team-b', 'Beta Team', 'BET')]])
    ])
    const { listTeams } = await import('./teams')

    await expect(listTeams('all')).resolves.toMatchObject([
      { id: 'team-a', workspaceId: 'workspace-1', workspaceName: 'Alpha' },
      { id: 'team-b', workspaceId: 'workspace-2', workspaceName: 'Beta' }
    ])
  })

  it('keeps partial workspace errors for agent team lists', async () => {
    getClients.mockReturnValue([
      makeEntry('workspace-1', 'Alpha', 'alpha', [[team('team-a', 'Alpha Team', 'ALP')]]),
      makeFailingEntry('workspace-2', 'Beta', new Error('fetch failed'))
    ])
    const { listTeamsForAgent } = await import('./teams')

    await expect(listTeamsForAgent('all')).resolves.toMatchObject({
      teams: [{ id: 'team-a', workspaceId: 'workspace-1', workspaceName: 'Alpha' }],
      errors: [
        {
          workspaceId: 'workspace-2',
          workspaceName: 'Beta',
          type: 'unknown',
          message: 'fetch failed'
        }
      ]
    })
  })

  it('fetches every page of team labels', async () => {
    const labels = vi
      .fn()
      .mockResolvedValue(
        makeConnection([
          [makeLabel('label-1', 'Bug')],
          [makeLabel('label-2', 'Feature')],
          [makeLabel('label-3', 'Docs')]
        ])
      )
    const entry = makeTeamLookupEntry('workspace-1', 'Workspace', { labels })
    getClients.mockReturnValue([entry])
    const { getTeamLabelsOrThrow } = await import('./teams')

    await expect(getTeamLabelsOrThrow('team-1', 'workspace-1')).resolves.toEqual([
      { id: 'label-1', name: 'Bug', color: '#ff0000' },
      { id: 'label-2', name: 'Feature', color: '#ff0000' },
      { id: 'label-3', name: 'Docs', color: '#ff0000' }
    ])

    expect(entry.client.team).toHaveBeenCalledWith('team-1')
    expect(labels).toHaveBeenCalledWith({ first: 100 })
  })

  it('fetches every page of team states', async () => {
    const states = vi
      .fn()
      .mockResolvedValue(
        makeConnection([
          [makeState('state-2', 'Doing', 2)],
          [makeState('state-1', 'Todo', 1)],
          [makeState('state-3', 'Review', 3)]
        ])
      )
    const entry = makeTeamLookupEntry('workspace-1', 'Workspace', { states })
    getClients.mockReturnValue([entry])
    const { getTeamStatesOrThrow } = await import('./teams')

    await expect(getTeamStatesOrThrow('team-1', 'workspace-1')).resolves.toEqual([
      { id: 'state-1', name: 'Todo', type: 'started', color: '#00ff00', position: 1 },
      { id: 'state-2', name: 'Doing', type: 'started', color: '#00ff00', position: 2 },
      { id: 'state-3', name: 'Review', type: 'started', color: '#00ff00', position: 3 }
    ])

    expect(entry.client.team).toHaveBeenCalledWith('team-1')
    expect(states).toHaveBeenCalledWith({ first: 100 })
  })

  it('fetches every page of team members', async () => {
    const members = vi
      .fn()
      .mockResolvedValue(
        makeConnection([
          [makeMember('user-1', 'Ada')],
          [makeMember('user-2', 'Grace')],
          [makeMember('user-3', 'Linus')]
        ])
      )
    const entry = makeTeamLookupEntry('workspace-1', 'Workspace', { members })
    getClients.mockReturnValue([entry])
    const { getTeamMembersOrThrow } = await import('./teams')

    await expect(getTeamMembersOrThrow('team-1', 'workspace-1')).resolves.toEqual([
      { id: 'user-1', displayName: 'Ada', avatarUrl: undefined },
      { id: 'user-2', displayName: 'Grace', avatarUrl: undefined },
      { id: 'user-3', displayName: 'Linus', avatarUrl: undefined }
    ])

    expect(entry.client.team).toHaveBeenCalledWith('team-1')
    expect(members).toHaveBeenCalledWith({ first: 100 })
  })

  it('surfaces Linear credential decrypt errors on active team reads', async () => {
    const error = new Error(credentialDecryptionMessage('Linear'))
    getClients.mockImplementation(() => {
      throw error
    })
    const { listTeams } = await import('./teams')

    await expect(listTeams('workspace-1')).rejects.toThrow(error.message)
  })
})
