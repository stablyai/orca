import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveProjectCreateScope = vi.fn()
const resolveWorkspaceUserForWrite = vi.fn()
const resolveProjectStatusForWrite = vi.fn()
const resolveProjectLabelsForWrite = vi.fn()

vi.mock('../../linear/project-create-workspace-scope', () => ({
  resolveProjectCreateScope: (...args: unknown[]) => resolveProjectCreateScope(...args)
}))
vi.mock('../../linear/project-write-actors', () => ({
  resolveWorkspaceUserForWrite: (...args: unknown[]) => resolveWorkspaceUserForWrite(...args)
}))
vi.mock('../../linear/project-write-references', () => ({
  resolveProjectStatusForWrite: (...args: unknown[]) => resolveProjectStatusForWrite(...args),
  resolveProjectLabelsForWrite: (...args: unknown[]) => resolveProjectLabelsForWrite(...args)
}))

const { resolveLinearProjectCreateIntent } = await import('./linear-project-create-resolution')

const WORKSPACE_ID = 'a1b2c3d4-e5f6-4718-9a0b-1c2d3e4f5a6b'
const TEAM_ID = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f'
const USER_ID = 'e6f7a8b9-c0d1-4e2f-8a3b-4c5d6e7f8091'

beforeEach(() => {
  vi.clearAllMocks()
  resolveProjectCreateScope.mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Acme',
    teams: [{ id: TEAM_ID, name: 'Engineering', key: 'ENG' }]
  })
  resolveWorkspaceUserForWrite.mockResolvedValue({ id: USER_ID, displayName: 'Ada' })
  resolveProjectStatusForWrite.mockResolvedValue({ id: 'status-1', name: 'In Progress' })
  resolveProjectLabelsForWrite.mockResolvedValue([{ id: 'label-1', name: 'Launch' }])
})

describe('resolveLinearProjectCreateIntent', () => {
  it('trims the name, normalizes prose without trimming it, and keeps priority 0', async () => {
    const intent = await resolveLinearProjectCreateIntent({
      name: '  Aurora  ',
      teams: ['ENG'],
      description: '  one\r\ntwo  ',
      content: '',
      priority: 0
    })

    expect(intent).toMatchObject({
      workspaceId: WORKSPACE_ID,
      name: 'Aurora',
      teamIds: [TEAM_ID],
      description: '  one\ntwo  ',
      content: '',
      priority: 0
    })
  })

  it('rejects a whitespace-only name before any workspace lookup', async () => {
    await expect(resolveLinearProjectCreateIntent({ name: '   ', teams: ['ENG'] })).rejects.toThrow(
      'A Linear project name is required.'
    )
    expect(resolveProjectCreateScope).not.toHaveBeenCalled()
  })

  it('resolves every other reference inside the workspace the teams selected', async () => {
    const intent = await resolveLinearProjectCreateIntent({
      name: 'Aurora',
      teams: ['ENG', ' eng ', 'DES'],
      status: 'In Progress',
      lead: 'me',
      members: ['ada@example.com', 'ada@example.com'],
      labels: ['Launch']
    })

    // Why: repeated team spellings must not cost one lookup per connected workspace.
    expect(resolveProjectCreateScope).toHaveBeenCalledWith(['ENG', 'DES'], undefined, {})
    expect(resolveProjectStatusForWrite).toHaveBeenCalledWith('In Progress', WORKSPACE_ID, {})
    expect(resolveWorkspaceUserForWrite).toHaveBeenCalledWith('me', WORKSPACE_ID, {})
    expect(resolveProjectLabelsForWrite).toHaveBeenCalledWith(['Launch'], WORKSPACE_ID, {})
    expect(intent).toMatchObject({
      statusId: 'status-1',
      leadId: USER_ID,
      memberIds: [USER_ID],
      labelIds: ['label-1']
    })
  })

  it('omits every unrequested field so create defaults stay untouched', async () => {
    const intent = await resolveLinearProjectCreateIntent({ name: 'Aurora', teams: ['ENG'] })

    expect(intent).toEqual({ workspaceId: WORKSPACE_ID, name: 'Aurora', teamIds: [TEAM_ID] })
    expect(resolveProjectStatusForWrite).not.toHaveBeenCalled()
    expect(resolveWorkspaceUserForWrite).not.toHaveBeenCalled()
    expect(resolveProjectLabelsForWrite).not.toHaveBeenCalled()
  })
})
