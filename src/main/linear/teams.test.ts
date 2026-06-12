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

function team(id: string, name = id, key = id.toUpperCase()): TeamNode {
  return { id, name, key }
}

function makeTeamConnection(pages: TeamNode[][]) {
  const nodes = [...(pages[0] ?? [])]
  let pageIndex = 0
  return {
    nodes,
    pageInfo: { hasNextPage: pages.length > 1 },
    fetchNext: vi
      .fn()
      .mockImplementation(
        async function fetchNext(this: { nodes: TeamNode[]; pageInfo: { hasNextPage: boolean } }) {
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
      teams: vi.fn().mockResolvedValue(makeTeamConnection(pages))
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

  it('surfaces Linear credential decrypt errors on active team reads', async () => {
    const error = new Error(credentialDecryptionMessage('Linear'))
    getClients.mockImplementation(() => {
      throw error
    })
    const { listTeams } = await import('./teams')

    await expect(listTeams('workspace-1')).rejects.toThrow(error.message)
  })
})
