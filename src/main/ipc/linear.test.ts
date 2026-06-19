import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  listIssuesMock,
  listProjectIssuesMock,
  listCustomViewIssuesMock,
  connectMock,
  disconnectMock,
  getStatusMock,
  selectWorkspaceMock,
  testConnectionMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  listIssuesMock: vi.fn(),
  listProjectIssuesMock: vi.fn(),
  listCustomViewIssuesMock: vi.fn(),
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  getStatusMock: vi.fn(),
  selectWorkspaceMock: vi.fn(),
  testConnectionMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../linear/client', () => ({
  connect: connectMock,
  disconnect: disconnectMock,
  getStatus: getStatusMock,
  selectWorkspace: selectWorkspaceMock,
  testConnection: testConnectionMock
}))

vi.mock('../linear/issues', () => ({
  getIssue: vi.fn(),
  searchIssues: vi.fn(),
  listIssues: listIssuesMock,
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  addIssueComment: vi.fn(),
  getIssueComments: vi.fn()
}))

vi.mock('../linear/projects', () => ({
  getCustomView: vi.fn(),
  getProject: vi.fn(),
  listCustomViewIssues: listCustomViewIssuesMock,
  listCustomViewProjects: vi.fn(),
  listCustomViews: vi.fn(),
  listProjectIssues: listProjectIssuesMock,
  listProjects: vi.fn()
}))

vi.mock('../linear/teams', () => ({
  listTeams: vi.fn(),
  getTeamStates: vi.fn(),
  getTeamLabels: vi.fn(),
  getTeamMembers: vi.fn()
}))

vi.mock('./preflight', () => ({
  _resetPreflightCache: vi.fn()
}))

import { registerLinearHandlers } from './linear'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerLinearHandlers', () => {
  const handlers: HandlerMap = {}

  beforeEach(() => {
    handleMock.mockReset()
    listIssuesMock.mockReset()
    listProjectIssuesMock.mockReset()
    listCustomViewIssuesMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
  })

  it('forwards expanded Linear issue list limits through local IPC', async () => {
    listIssuesMock.mockResolvedValue({ items: [], hasMore: true })

    registerLinearHandlers()
    await handlers['linear:listIssues'](null, {
      filter: 'all',
      limit: 216,
      workspaceId: 'workspace-1'
    })

    expect(listIssuesMock).toHaveBeenCalledWith('all', 216, 'workspace-1')
  })

  it('forwards expanded Linear project issue limits through local IPC', async () => {
    listProjectIssuesMock.mockResolvedValue({ items: [], hasMore: true })

    registerLinearHandlers()
    await handlers['linear:listProjectIssues'](null, {
      projectId: 'project-1',
      limit: 216,
      workspaceId: 'workspace-1'
    })

    expect(listProjectIssuesMock).toHaveBeenCalledWith('project-1', 216, 'workspace-1', false)
  })

  it('forwards expanded Linear custom view issue limits through local IPC', async () => {
    listCustomViewIssuesMock.mockResolvedValue({ items: [], hasMore: true })

    registerLinearHandlers()
    await handlers['linear:listCustomViewIssues'](null, {
      viewId: 'view-1',
      limit: 216,
      workspaceId: 'workspace-1'
    })

    expect(listCustomViewIssuesMock).toHaveBeenCalledWith('view-1', 216, 'workspace-1', false)
  })
})
