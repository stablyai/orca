import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, args: unknown) => Promise<unknown> | unknown
  return {
    handlers: new Map<string, Handler>(),
    statusCalls: 0,
    connectCalls: [] as unknown[],
    disconnectCalls: [] as unknown[],
    selectConnectionCalls: [] as unknown[],
    listIssuesCalls: [] as unknown[],
    createIssueResult: undefined as unknown
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: unknown) => {
      mocks.handlers.set(channel, handler as never)
    }
  }
}))

vi.mock('../huly/client', () => ({
  connect: (...args: unknown[]) => {
    mocks.connectCalls.push(args)
    return { ok: true, viewer: { displayName: 'me', email: 'me@example.com' } }
  },
  disconnect: (...args: unknown[]) => {
    mocks.disconnectCalls.push(args)
  },
  getStatus: () => {
    mocks.statusCalls += 1
    return {
      connected: true,
      viewer: null,
      connections: [],
      activeConnectionId: null,
      selectedConnectionId: null,
      cliInstalled: true,
      cliAuthenticated: true
    }
  },
  selectConnection: (...args: unknown[]) => {
    mocks.selectConnectionCalls.push(args)
    return {
      connected: true,
      connections: [],
      cliInstalled: true,
      cliAuthenticated: true,
      activeConnectionId: null,
      selectedConnectionId: null,
      viewer: null
    }
  },
  getPreflightStatus: () => ({ installed: true, authenticated: true, cliVersion: '1.2.3' })
}))

vi.mock('../huly/issues', () => ({
  listIssues: (...args: unknown[]) => {
    mocks.listIssuesCalls.push(args)
    return Promise.resolve([])
  },
  searchIssues: vi.fn().mockResolvedValue([]),
  getIssue: vi.fn().mockResolvedValue(null),
  createIssue: (..._args: unknown[]) =>
    Promise.resolve(mocks.createIssueResult ?? { ok: true, issue: { id: 'i-1' } }),
  updateIssue: vi.fn().mockResolvedValue({ ok: true }),
  addComment: vi.fn().mockResolvedValue({ ok: true, comment: { id: 'c-1' } }),
  listComments: vi.fn().mockResolvedValue([])
}))

vi.mock('../huly/projects', () => ({
  listProjects: vi.fn().mockResolvedValue([]),
  getProject: vi.fn().mockResolvedValue(null),
  createProject: vi.fn().mockResolvedValue({ ok: true, project: { id: 'p-1' } }),
  listProjectIssues: vi.fn().mockResolvedValue([])
}))

vi.mock('../huly/teams', () => ({
  listTeams: vi.fn().mockResolvedValue([]),
  getTeamMembers: vi.fn().mockResolvedValue([]),
  getTeamStates: vi.fn().mockResolvedValue([]),
  getTeamLabels: vi.fn().mockResolvedValue([])
}))

import { registerHulyHandlers } from './huly'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.statusCalls = 0
  mocks.connectCalls = []
  mocks.disconnectCalls = []
  mocks.selectConnectionCalls = []
  mocks.listIssuesCalls = []
  mocks.createIssueResult = undefined
  registerHulyHandlers()
})

function callHandler(channel: string, args: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return Promise.resolve(handler(null, args))
}

describe('registerHulyHandlers', () => {
  it('registers all expected IPC channels', () => {
    const expected = [
      'huly:connect',
      'huly:disconnect',
      'huly:selectConnection',
      'huly:status',
      'huly:preflight',
      'huly:listIssues',
      'huly:searchIssues',
      'huly:getIssue',
      'huly:createIssue',
      'huly:updateIssue',
      'huly:addComment',
      'huly:listComments',
      'huly:listProjects',
      'huly:getProject',
      'huly:createProject',
      'huly:listProjectIssues',
      'huly:listTeams',
      'huly:teamMembers',
      'huly:teamStates',
      'huly:teamLabels'
    ]
    for (const channel of expected) {
      expect(mocks.handlers.has(channel)).toBe(true)
    }
  })

  it('huly:connect validates required fields', async () => {
    const result = await callHandler('huly:connect', {
      name: '',
      url: '',
      workspace: '',
      secret: ''
    })
    expect(result).toEqual({ ok: false, error: 'Connection name is required' })
  })

  it('huly:connect rejects missing URL', async () => {
    const result = await callHandler('huly:connect', {
      name: 'My',
      url: '',
      workspace: 'main',
      secret: 't'
    })
    expect(result).toEqual({ ok: false, error: 'Huly URL is required' })
  })

  it('huly:connect rejects missing workspace', async () => {
    const result = await callHandler('huly:connect', {
      name: 'My',
      url: 'https://huly.app',
      workspace: '',
      secret: 't'
    })
    expect(result).toEqual({ ok: false, error: 'Workspace is required' })
  })

  it('huly:connect rejects missing secret', async () => {
    const result = await callHandler('huly:connect', {
      name: 'My',
      url: 'https://huly.app',
      workspace: 'main',
      secret: ''
    })
    expect(result).toEqual({ ok: false, error: 'A token or password is required' })
  })

  it('huly:connect trims and forwards valid args to the client', async () => {
    const result = await callHandler('huly:connect', {
      name: '  My Huly  ',
      url: '  https://huly.app  ',
      workspace: '  main  ',
      email: '  me@example.com  ',
      secret: '  token  '
    })
    expect(result).toEqual({ ok: true, viewer: expect.anything() })
    expect(mocks.connectCalls[0]?.[0]).toEqual({
      name: 'My Huly',
      url: 'https://huly.app',
      workspace: 'main',
      email: 'me@example.com',
      secret: 'token'
    })
  })

  it('huly:status returns the connection status without args', async () => {
    const result = await callHandler('huly:status', undefined)
    expect(mocks.statusCalls).toBe(1)
    expect(result).toEqual(expect.objectContaining({ connected: true, cliInstalled: true }))
  })

  it('huly:disconnect forwards the connectionId to the client', async () => {
    await callHandler('huly:disconnect', { connectionId: 'huly-1' })
    expect(mocks.disconnectCalls[0]?.[0]).toBe('huly-1')
  })

  it('huly:selectConnection rejects when the connectionId is missing', async () => {
    const result = await callHandler('huly:selectConnection', { connectionId: '' })
    // Why: empty connectionId triggers the fallback getStatus() path.
    expect(result).toEqual(expect.objectContaining({ connected: true }))
    expect(mocks.selectConnectionCalls).toEqual([])
  })

  it('huly:listIssues clamps the limit and forwards filter', async () => {
    await callHandler('huly:listIssues', { filter: 'assigned', limit: 1000 })
    const args = mocks.listIssuesCalls[0] as [string, number, string | null]
    expect(args[0]).toBe('assigned')
    expect(args[1]).toBe(200)
  })

  it('huly:createIssue rejects missing title', async () => {
    const result = await callHandler('huly:createIssue', {
      teamId: 'team-1',
      title: ''
    })
    expect(result).toEqual({ ok: false, error: 'Title is required' })
  })

  it('huly:createIssue rejects missing teamId', async () => {
    const result = await callHandler('huly:createIssue', {
      teamId: '',
      title: 'x'
    })
    expect(result).toEqual({ ok: false, error: 'Team ID is required' })
  })

  it('huly:getIssue returns null for missing id', async () => {
    const result = await callHandler('huly:getIssue', { id: '' })
    expect(result).toBeNull()
  })

  it('huly:addComment rejects missing body', async () => {
    const result = await callHandler('huly:addComment', { issueId: 'i-1', body: '' })
    expect(result).toEqual({ ok: false, error: 'Comment body is required' })
  })

  it('huly:addComment rejects missing issueId', async () => {
    const result = await callHandler('huly:addComment', { issueId: '', body: 'x' })
    expect(result).toEqual({ ok: false, error: 'Issue ID is required' })
  })
})
