import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { credentialDecryptionMessage } from '../../shared/integration-credential-errors'

const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()
const acquire = vi.fn().mockResolvedValue(undefined)
const release = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire,
  release
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args)
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
  name?: string | null
  email?: string | null
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
  teamNode: unknown,
  options?: { viewer?: () => Promise<{ id: string }>; credentialRevision?: number }
): LinearClientForWorkspace {
  return {
    workspace: {
      id: workspaceId,
      organizationId: workspaceId,
      organizationName,
      displayName: 'Ada',
      email: 'ada@example.com',
      credentialRevision: options?.credentialRevision
    },
    client: {
      team: vi.fn().mockResolvedValue(teamNode),
      get viewer() {
        return options?.viewer ? options.viewer() : Promise.reject(new Error('no viewer mock'))
      }
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
          [{ ...makeMember('user-1', 'Ada'), name: 'Ada Lovelace', email: 'ada@example.com' }],
          [makeMember('user-2', 'Grace')],
          [makeMember('user-3', 'Linus')]
        ])
      )
    const entry = makeTeamLookupEntry(
      'workspace-1',
      'Workspace',
      { members },
      {
        viewer: () => Promise.resolve({ id: 'user-1' })
      }
    )
    getClients.mockReturnValue([entry])
    const { getTeamMembersOrThrow } = await import('./teams')

    await expect(getTeamMembersOrThrow('team-1', 'workspace-1')).resolves.toEqual([
      {
        id: 'user-1',
        displayName: 'Ada',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        avatarUrl: undefined
      },
      {
        id: 'user-2',
        displayName: 'Grace',
        name: undefined,
        email: undefined,
        avatarUrl: undefined
      },
      {
        id: 'user-3',
        displayName: 'Linus',
        name: undefined,
        email: undefined,
        avatarUrl: undefined
      }
    ])

    expect(entry.client.team).toHaveBeenCalledWith('team-1')
    expect(members).toHaveBeenCalledWith({ first: 100 })
  })

  it.each([
    ['getTeamStates', 'getTeamStatesOrThrow'],
    ['getTeamLabels', 'getTeamLabelsOrThrow'],
    ['getTeamMembers', 'getTeamMembersOrThrow']
  ] as const)('preserves the %s error policy', async (fallbackReader, throwingReader) => {
    const error = new Error('request failed')
    const entry = makeTeamLookupEntry('workspace-1', 'Workspace', null)
    vi.mocked(entry.client.team).mockRejectedValue(error)
    getClients.mockReturnValue([entry])
    const readers = await import('./teams')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(readers[fallbackReader]('team-1', 'workspace-1')).resolves.toEqual([])
    await expect(readers[throwingReader]('team-1', 'workspace-1')).rejects.toBe(error)
    expect(warn).toHaveBeenCalledWith(`[linear] ${fallbackReader} failed:`, error)
    expect(release).toHaveBeenCalledTimes(2)

    isAuthError.mockReturnValue(true)
    await expect(readers[fallbackReader]('team-1', 'workspace-1')).rejects.toBe(error)
    expect(clearToken).toHaveBeenCalledWith('workspace-1')
    expect(release).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  describe('viewer-first member ordering', () => {
    beforeEach(() => {
      vi.resetModules()
    })

    function makeMembersEntry(options?: {
      viewer?: () => Promise<{ id: string }>
      credentialRevision?: number
      memberPages?: MemberNode[][]
    }): LinearClientForWorkspace {
      const members = vi.fn().mockResolvedValue(
        makeConnection(
          options?.memberPages ?? [
            [makeMember('user-1', 'brian'), makeMember('user-2', 'pika')],
            [makeMember('user-3', 'andrew'), makeMember('user-4', 'sean')]
          ]
        )
      )
      return makeTeamLookupEntry('workspace-1', 'Workspace', { members }, options)
    }

    it('pins the viewer first and alpha-sorts the rest', async () => {
      const viewer = vi.fn().mockResolvedValue({ id: 'user-3' })
      getClients.mockReturnValue([makeMembersEntry({ viewer })])
      const { getTeamMembersOrThrow } = await import('./teams')

      await expect(getTeamMembersOrThrow('team-1', 'workspace-1')).resolves.toMatchObject([
        { id: 'user-3', displayName: 'andrew' },
        { id: 'user-1', displayName: 'brian' },
        { id: 'user-2', displayName: 'pika' },
        { id: 'user-4', displayName: 'sean' }
      ])
    })

    it('alpha-sorts when the viewer is not a team member', async () => {
      const viewer = vi.fn().mockResolvedValue({ id: 'user-elsewhere' })
      getClients.mockReturnValue([makeMembersEntry({ viewer })])
      const { getTeamMembers } = await import('./teams')

      await expect(getTeamMembers('team-1', 'workspace-1')).resolves.toMatchObject([
        { id: 'user-3' },
        { id: 'user-1' },
        { id: 'user-2' },
        { id: 'user-4' }
      ])
    })

    it('falls back to alpha order when the viewer lookup fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const viewer = vi.fn().mockRejectedValue(new Error('viewer down'))
        getClients.mockReturnValue([makeMembersEntry({ viewer })])
        const { getTeamMembersOrThrow } = await import('./teams')

        await expect(getTeamMembersOrThrow('team-1', 'workspace-1')).resolves.toMatchObject([
          { id: 'user-3' },
          { id: 'user-1' },
          { id: 'user-2' },
          { id: 'user-4' }
        ])
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('viewer lookup'),
          expect.any(Error)
        )
      } finally {
        warn.mockRestore()
      }
    })

    it('shares one in-flight viewer lookup across concurrent member fetches', async () => {
      let resolveViewer: (value: { id: string }) => void = () => {}
      const viewer = vi.fn().mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveViewer = resolve
          })
      )
      getClients.mockReturnValue([makeMembersEntry({ viewer })])
      const { getTeamMembersOrThrow } = await import('./teams')

      const first = getTeamMembersOrThrow('team-1', 'workspace-1')
      const second = getTeamMembersOrThrow('team-1', 'workspace-1')
      await vi.waitFor(() => expect(viewer).toHaveBeenCalledTimes(1))
      resolveViewer({ id: 'user-3' })

      const expectedOrder = [{ id: 'user-3' }, { id: 'user-1' }, { id: 'user-2' }, { id: 'user-4' }]
      await expect(first).resolves.toMatchObject(expectedOrder)
      await expect(second).resolves.toMatchObject(expectedOrder)
      expect(viewer).toHaveBeenCalledTimes(1)
    })

    it('caches the viewer id per workspace credential revision', async () => {
      const viewer = vi.fn().mockResolvedValue({ id: 'user-3' })
      getClients.mockReturnValue([makeMembersEntry({ viewer, credentialRevision: 1 })])
      const { getTeamMembersOrThrow } = await import('./teams')

      await getTeamMembersOrThrow('team-1', 'workspace-1')
      await getTeamMembersOrThrow('team-1', 'workspace-1')
      expect(viewer).toHaveBeenCalledTimes(1)

      // Credential rotation invalidates the cached viewer id.
      getClients.mockReturnValue([makeMembersEntry({ viewer, credentialRevision: 2 })])
      await getTeamMembersOrThrow('team-1', 'workspace-1')
      expect(viewer).toHaveBeenCalledTimes(2)
    })

    it('sorts members deterministically with duplicate display names', async () => {
      const { sortMembersViewerFirst } = await import('./team-member-order')

      expect(sortMembersViewerFirst([], null)).toEqual([])
      expect(
        sortMembersViewerFirst(
          [
            { id: 'user-b', displayName: 'sam' },
            { id: 'user-a', displayName: 'sam' },
            { id: 'user-c', displayName: 'alex' }
          ],
          'user-b'
        )
      ).toMatchObject([{ id: 'user-b' }, { id: 'user-c' }, { id: 'user-a' }])
    })
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
