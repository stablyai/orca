import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', async () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode = process.env.ORCA_PAIRING_CODE ?? null,
      environmentSelector = process.env.ORCA_ENVIRONMENT ?? null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
  }

  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca plane CLI handlers', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.env = { ...originalEnv }
    delete process.env.ORCA_WORKTREE_ID
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PAIRING_CODE
    delete process.env.ORCA_ENVIRONMENT
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('runs orca plane status', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        connected: true,
        instanceUrl: 'https://api.plane.so',
        authType: 'cloud',
        workspaces: [{ id: 'w1', name: 'Acme', slug: 'acme' }],
        activeWorkspaceSlug: 'acme',
        viewer: { id: 'u1', displayName: 'Jane' }
      })
    )

    await main(['plane', 'status', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.status')
  })

  it('runs orca plane connect', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        ok: true,
        viewer: { id: 'u1', displayName: 'Jane' }
      })
    )

    await main(
      [
        'plane',
        'connect',
        '--token',
        'plane-token-123',
        '--base-url',
        'https://plane.myco.com',
        '--auth-type',
        'self-hosted',
        '--json'
      ],
      '/tmp'
    )

    expect(callMock).toHaveBeenCalledWith('plane.connect', {
      apiKey: 'plane-token-123',
      baseUrl: 'https://plane.myco.com',
      authType: 'self-hosted'
    })
  })

  it('runs orca plane disconnect', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        connected: false,
        instanceUrl: 'https://api.plane.so',
        authType: 'cloud',
        workspaces: [],
        activeWorkspaceSlug: null,
        viewer: null
      })
    )

    await main(['plane', 'disconnect', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.disconnect')
  })

  it('runs orca plane workspace list', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        connected: true,
        instanceUrl: 'https://api.plane.so',
        authType: 'cloud',
        workspaces: [{ id: 'w1', name: 'Acme', slug: 'acme' }],
        activeWorkspaceSlug: 'acme',
        viewer: { id: 'u1', displayName: 'Jane' }
      })
    )

    await main(['plane', 'workspace', 'list', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.status')
  })

  it('runs orca plane workspace select', async () => {
    queueFixtures(callMock, okFixture('req_1', { ok: true, selectedSlug: 'acme' }))

    await main(['plane', 'workspace', 'select', 'acme', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.selectWorkspace', { slug: 'acme' })
  })

  it('runs orca plane project list', async () => {
    queueFixtures(callMock, okFixture('req_1', []))

    await main(['plane', 'project', 'list', '--workspace', 'acme', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.listProjects', {
      workspaceSlug: 'acme'
    })
  })

  it('runs orca plane state list', async () => {
    queueFixtures(callMock, okFixture('req_1', []))

    await main(
      ['plane', 'state', 'list', '--project', 'proj-1', '--workspace', 'acme', '--json'],
      '/tmp'
    )
    expect(callMock).toHaveBeenCalledWith('plane.listStates', {
      projectId: 'proj-1',
      workspaceSlug: 'acme'
    })
  })

  it('runs orca plane list', async () => {
    queueFixtures(callMock, okFixture('req_1', []))

    await main(['plane', 'list', '--project', 'proj-1', '--limit', '10', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.listIssues', {
      projectId: 'proj-1',
      workspaceSlug: undefined,
      limit: 10
    })
  })

  it('runs orca plane issue', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        issue: {
          id: 'iss-1',
          key: 'ENG-1',
          title: 'Test issue',
          url: 'https://api.plane.so',
          state: { id: 's1', name: 'Todo', group: 'unstarted' },
          priority: 'high',
          project: { id: 'p1', identifier: 'ENG', name: 'Engineering' },
          assignees: [],
          labels: []
        },
        comments: []
      })
    )

    await main(['plane', 'issue', 'ENG-1', '--comments', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.getIssue', {
      id: 'ENG-1',
      projectId: undefined,
      workspaceSlug: undefined,
      includeComments: true
    })
  })

  it('runs orca plane create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        id: 'iss-1',
        key: 'ENG-2',
        title: 'New issue',
        url: 'https://api.plane.so'
      })
    )

    await main(
      [
        'plane',
        'create',
        '--title',
        'New issue',
        '--project',
        'proj-1',
        '--priority',
        'urgent',
        '--body',
        'Issue details',
        '--json'
      ],
      '/tmp'
    )

    expect(callMock).toHaveBeenCalledWith('plane.createIssue', {
      title: 'New issue',
      projectId: 'proj-1',
      workspaceSlug: undefined,
      stateId: undefined,
      priority: 'urgent',
      description: 'Issue details'
    })
  })

  it('runs orca plane status set', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', {
        issueId: 'iss-1',
        state: { id: 's2', name: 'In Progress' }
      })
    )

    await main(['plane', 'status', 'set', 'ENG-1', '--to', 'In Progress', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.issueSetState', {
      id: 'ENG-1',
      to: 'In Progress',
      projectId: undefined,
      workspaceSlug: undefined
    })
  })

  it('runs orca plane priority set and clear', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', { issueId: 'iss-1', priority: 'high' }),
      okFixture('req_2', { issueId: 'iss-1', priority: 'none' })
    )

    await main(['plane', 'priority', 'set', 'ENG-1', '--to', 'high', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.issueSetPriority', {
      id: 'ENG-1',
      priority: 'high',
      projectId: undefined,
      workspaceSlug: undefined
    })

    await main(['plane', 'priority', 'clear', 'ENG-1', '--json'], '/tmp')
    expect(callMock).toHaveBeenCalledWith('plane.issueSetPriority', {
      id: 'ENG-1',
      priority: 'none',
      projectId: undefined,
      workspaceSlug: undefined
    })
  })

  it('runs orca plane comment add', async () => {
    queueFixtures(callMock, okFixture('req_1', { ok: true, issueId: 'iss-1' }))

    await main(
      ['plane', 'comment', 'add', 'ENG-1', '--body', 'Looks good to me', '--json'],
      '/tmp'
    )
    expect(callMock).toHaveBeenCalledWith('plane.issueAddComment', {
      id: 'ENG-1',
      body: 'Looks good to me',
      projectId: undefined,
      workspaceSlug: undefined
    })
  })
})
