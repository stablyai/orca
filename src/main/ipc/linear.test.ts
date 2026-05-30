import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'

const {
  listIssueLabelsMock,
  createIssueLabelMock,
  updateIssueLabelMock,
  retireIssueLabelMock,
  restoreIssueLabelMock
} = vi.hoisted(() => ({
  listIssueLabelsMock: vi.fn(),
  createIssueLabelMock: vi.fn(),
  updateIssueLabelMock: vi.fn(),
  retireIssueLabelMock: vi.fn(),
  restoreIssueLabelMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../linear/client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getStatus: vi.fn(() => ({ connected: true, viewer: null })),
  selectWorkspace: vi.fn(),
  testConnection: vi.fn()
}))

vi.mock('../linear/issues', () => ({
  getIssue: vi.fn(),
  searchIssues: vi.fn(),
  listIssues: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  addIssueComment: vi.fn(),
  getIssueComments: vi.fn()
}))

vi.mock('../linear/projects', () => ({
  listProjects: vi.fn()
}))

vi.mock('../linear/teams', () => ({
  listTeams: vi.fn(),
  getTeamStates: vi.fn(),
  getTeamLabels: vi.fn(),
  getTeamMembers: vi.fn()
}))

vi.mock('../linear/labels', () => ({
  listIssueLabels: (...args: unknown[]) => listIssueLabelsMock(...args),
  createIssueLabel: (...args: unknown[]) => createIssueLabelMock(...args),
  updateIssueLabel: (...args: unknown[]) => updateIssueLabelMock(...args),
  retireIssueLabel: (...args: unknown[]) => retireIssueLabelMock(...args),
  restoreIssueLabel: (...args: unknown[]) => restoreIssueLabelMock(...args)
}))

vi.mock('./preflight', () => ({
  _resetPreflightCache: vi.fn()
}))

import { registerLinearHandlers } from './linear'

describe('Linear IPC label catalog handlers', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

  beforeEach(() => {
    handlers.clear()
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    listIssueLabelsMock.mockReset()
    createIssueLabelMock.mockReset()
    updateIssueLabelMock.mockReset()
    retireIssueLabelMock.mockReset()
    restoreIssueLabelMock.mockReset()
    registerLinearHandlers()
  })

  it('lists issue labels with normalized workspace and team scope', async () => {
    listIssueLabelsMock.mockResolvedValue([{ id: 'label-1' }])

    await expect(
      handlers.get('linear:listIssueLabels')?.(null, {
        workspaceId: ' workspace-1 ',
        teamId: ' team-1 ',
        includeArchived: true
      })
    ).resolves.toEqual([{ id: 'label-1' }])

    expect(listIssueLabelsMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      includeArchived: true
    })
  })

  it('rejects invalid label list filter types before calling Linear', async () => {
    await expect(
      handlers.get('linear:listIssueLabels')?.(null, { workspaceId: 'workspace-1', teamId: 123 })
    ).rejects.toThrow('Label team ID must be a string')
    await expect(
      handlers.get('linear:listIssueLabels')?.(null, {
        workspaceId: 'workspace-1',
        includeArchived: 'yes'
      })
    ).rejects.toThrow('includeArchived must be a boolean')

    expect(listIssueLabelsMock).not.toHaveBeenCalled()
  })

  it('validates create label payloads before calling Linear', async () => {
    await expect(
      handlers.get('linear:createIssueLabel')?.(null, {
        workspaceId: 'workspace-1',
        input: { name: ' ' }
      })
    ).resolves.toEqual({ ok: false, error: 'Label name is required' })
    await expect(
      handlers.get('linear:createIssueLabel')?.(null, {
        workspaceId: 'workspace-1',
        input: { name: 'Bug', color: 123 }
      })
    ).resolves.toEqual({ ok: false, error: 'Label color must be a string' })
    await expect(
      handlers.get('linear:createIssueLabel')?.(null, {
        workspaceId: 123,
        input: { name: 'Bug' }
      })
    ).resolves.toEqual({ ok: false, error: 'Workspace ID must be a string' })
    await expect(
      handlers.get('linear:createIssueLabel')?.(null, {
        workspaceId: 'workspace-1',
        input: { name: 'Bug', isGroup: 'yes' }
      })
    ).resolves.toEqual({ ok: false, error: 'Label group flag must be a boolean' })

    expect(createIssueLabelMock).not.toHaveBeenCalled()
  })

  it('creates and updates labels with trimmed string fields and nullable parent fields', async () => {
    createIssueLabelMock.mockResolvedValue({ ok: true, label: { id: 'label-1' } })
    updateIssueLabelMock.mockResolvedValue({ ok: true, label: { id: 'label-1' } })

    await handlers.get('linear:createIssueLabel')?.(null, {
      workspaceId: ' workspace-1 ',
      input: { name: ' Bug ', color: ' #eb5757 ', description: ' Defects ', teamId: ' team-1 ' }
    })
    await handlers.get('linear:updateIssueLabel')?.(null, {
      id: ' label-1 ',
      workspaceId: ' workspace-1 ',
      input: { name: ' Defect ', parentId: null }
    })

    expect(createIssueLabelMock).toHaveBeenCalledWith(
      { name: 'Bug', color: '#eb5757', description: 'Defects', teamId: 'team-1' },
      'workspace-1'
    )
    expect(updateIssueLabelMock).toHaveBeenCalledWith(
      'label-1',
      { name: 'Defect', parentId: null },
      'workspace-1'
    )
  })

  it('validates retire and restore label IDs before calling Linear', async () => {
    await expect(
      handlers.get('linear:retireIssueLabel')?.(null, { id: ' ', workspaceId: 'workspace-1' })
    ).resolves.toEqual({ ok: false, error: 'Label ID is required' })
    await expect(
      handlers.get('linear:restoreIssueLabel')?.(null, { id: ' ', workspaceId: 'workspace-1' })
    ).resolves.toEqual({ ok: false, error: 'Label ID is required' })

    expect(retireIssueLabelMock).not.toHaveBeenCalled()
    expect(restoreIssueLabelMock).not.toHaveBeenCalled()
  })
})
