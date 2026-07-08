import { beforeEach, describe, expect, it, vi } from 'vitest'

const { connectMock, handleMock, updateIssueMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  handleMock: vi.fn(),
  updateIssueMock: vi.fn()
}))

type IpcHandler = (_event: unknown, args?: unknown) => Promise<unknown> | unknown

const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
      handleMock(channel, handler)
    }
  }
}))

vi.mock('../jira/client', () => ({
  connect: (...args: unknown[]) => connectMock(...args),
  disconnect: vi.fn(),
  getStatus: vi.fn(() => ({ connected: false, viewer: null })),
  selectSite: vi.fn(() => ({ connected: false, viewer: null })),
  testConnection: vi.fn(() => ({ ok: false, error: 'Not connected to Jira.' }))
}))

vi.mock('../jira/issues', () => ({
  addIssueComment: vi.fn(),
  createIssue: vi.fn(),
  getIssue: vi.fn(),
  getIssueComments: vi.fn(),
  listAssignableUsers: vi.fn(),
  listCreateFields: vi.fn(),
  listIssueTypes: vi.fn(),
  listIssues: vi.fn(),
  listPriorities: vi.fn(),
  listProjects: vi.fn(),
  listTransitions: vi.fn(),
  searchIssues: vi.fn(),
  updateIssue: (...args: unknown[]) => updateIssueMock(...args)
}))

vi.mock('./preflight', () => ({
  _resetPreflightCache: vi.fn()
}))

async function registerHandlers(): Promise<void> {
  handlers.clear()
  vi.resetModules()
  const { registerJiraHandlers } = await import('./jira')
  registerJiraHandlers()
}

function handler(channel: string): IpcHandler {
  const registered = handlers.get(channel)
  if (!registered) {
    throw new Error(`Missing IPC handler ${channel}`)
  }
  return registered
}

describe('Jira IPC handlers', () => {
  beforeEach(async () => {
    connectMock.mockReset()
    updateIssueMock.mockReset()
    connectMock.mockResolvedValue({ ok: true, viewer: { displayName: 'Ada' } })
    updateIssueMock.mockResolvedValue({ ok: true })
    await registerHandlers()
  })

  it('accepts Jira Server Basic connect payloads', async () => {
    await expect(
      handler('jira:connect')(
        {},
        {
          deploymentType: 'server',
          authMode: 'basic',
          siteUrl: ' https://jira.example.internal ',
          username: ' ada ',
          passwordOrToken: ' secret '
        }
      )
    ).resolves.toMatchObject({ ok: true })

    expect(connectMock).toHaveBeenCalledWith({
      deploymentType: 'server',
      authMode: 'basic',
      siteUrl: 'https://jira.example.internal',
      username: 'ada',
      passwordOrToken: 'secret'
    })
  })

  it('accepts Jira Server Bearer connect payloads', async () => {
    await expect(
      handler('jira:connect')(
        {},
        {
          deploymentType: 'server',
          authMode: 'bearer',
          siteUrl: 'https://jira.example.internal',
          bearerToken: ' pat-secret '
        }
      )
    ).resolves.toMatchObject({ ok: true })

    expect(connectMock).toHaveBeenCalledWith({
      deploymentType: 'server',
      authMode: 'bearer',
      siteUrl: 'https://jira.example.internal',
      bearerToken: 'pat-secret'
    })
  })

  it('rejects mixed Jira connect payloads', async () => {
    await expect(
      handler('jira:connect')(
        {},
        {
          deploymentType: 'server',
          authMode: 'bearer',
          siteUrl: 'https://jira.example.internal',
          username: 'ada',
          bearerToken: 'pat-secret'
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Invalid key in Jira connection settings: username.'
    })

    expect(connectMock).not.toHaveBeenCalled()
  })

  it('accepts legacy Jira Cloud connect payloads and rejects invalid deployment types', async () => {
    await expect(
      handler('jira:connect')(
        {},
        {
          siteUrl: ' https://example.atlassian.net ',
          email: ' ada@example.com ',
          apiToken: ' cloud-secret '
        }
      )
    ).resolves.toMatchObject({ ok: true })

    expect(connectMock).toHaveBeenCalledWith({
      deploymentType: 'cloud',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      apiToken: 'cloud-secret'
    })

    connectMock.mockClear()
    await expect(
      handler('jira:connect')(
        {},
        {
          deploymentType: 'data-center',
          siteUrl: 'https://jira.example.internal',
          email: 'ada@example.com',
          apiToken: 'cloud-secret'
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Jira deployment type must be Cloud or Server/Data Center.'
    })

    expect(connectMock).not.toHaveBeenCalled()
  })

  it('returns targeted Jira connect validation errors', async () => {
    await expect(
      handler('jira:connect')(
        {},
        {
          deploymentType: 'cloud',
          siteUrl: 'https://example.atlassian.net',
          email: '',
          apiToken: 'cloud-secret'
        }
      )
    ).resolves.toEqual({ ok: false, error: 'Email is required.' })

    await expect(
      handler('jira:connect')(
        {},
        {
          deploymentType: 'server',
          authMode: 'basic',
          siteUrl: 'https://jira.example.internal',
          username: 'ada',
          passwordOrToken: ' '
        }
      )
    ).resolves.toEqual({ ok: false, error: 'Password or token is required.' })

    expect(connectMock).not.toHaveBeenCalled()
  })

  it('accepts assigneeUserId issue updates', async () => {
    await expect(
      handler('jira:updateIssue')(
        {},
        {
          key: 'SRV-1',
          siteId: 'server-1',
          updates: { assigneeUserId: null }
        }
      )
    ).resolves.toEqual({ ok: true })

    expect(updateIssueMock).toHaveBeenCalledWith('SRV-1', { assigneeUserId: null }, 'server-1')
  })

  it('rejects invalid assigneeUserId issue updates', async () => {
    await expect(
      handler('jira:updateIssue')(
        {},
        {
          key: 'SRV-1',
          updates: { assigneeUserId: 123 }
        }
      )
    ).resolves.toEqual({ ok: false, error: 'Assignee user ID must be a string or null.' })

    expect(updateIssueMock).not.toHaveBeenCalled()
  })

  it('rejects mixed Jira assignee identifier issue updates', async () => {
    await expect(
      handler('jira:updateIssue')(
        {},
        {
          key: 'SRV-1',
          updates: { assigneeUserId: 'ada', assigneeAccountId: 'account-1' }
        }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Use only one Jira assignee identifier field.'
    })

    expect(updateIssueMock).not.toHaveBeenCalled()
  })
})
