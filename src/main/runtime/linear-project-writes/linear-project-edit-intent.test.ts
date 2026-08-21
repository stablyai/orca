import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveWorkspaceUserForWrite = vi.fn()
const resolveWorkspaceTeamsForWrite = vi.fn()
const resolveProjectStatusForWrite = vi.fn()
const resolveProjectLabelsForWrite = vi.fn()

vi.mock('../../linear/project-write-actors', () => ({
  resolveWorkspaceUserForWrite: (...args: unknown[]) => resolveWorkspaceUserForWrite(...args),
  resolveWorkspaceTeamsForWrite: (...args: unknown[]) => resolveWorkspaceTeamsForWrite(...args)
}))
vi.mock('../../linear/project-write-references', () => ({
  resolveProjectStatusForWrite: (...args: unknown[]) => resolveProjectStatusForWrite(...args),
  resolveProjectLabelsForWrite: (...args: unknown[]) => resolveProjectLabelsForWrite(...args)
}))

const { requestedLinearProjectEditFields, resolveLinearProjectEditIntent } =
  await import('./linear-project-edit-intent')

const WORKSPACE_ID = 'a1b2c3d4-e5f6-4718-9a0b-1c2d3e4f5a6b'
const TEAM_ID = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f'
const USER_ID = 'e6f7a8b9-c0d1-4e2f-8a3b-4c5d6e7f8091'

beforeEach(() => {
  vi.clearAllMocks()
  resolveWorkspaceUserForWrite.mockResolvedValue({ id: USER_ID, displayName: 'Ada' })
  resolveWorkspaceTeamsForWrite.mockResolvedValue([{ id: TEAM_ID, name: 'Engineering' }])
  resolveProjectStatusForWrite.mockResolvedValue({ id: 'status-1', name: 'In Progress' })
  resolveProjectLabelsForWrite.mockResolvedValue([{ id: 'label-1', name: 'Launch' }])
})

describe('requestedLinearProjectEditFields', () => {
  it('counts an explicit clear as requested and ignores absent fields', () => {
    expect(
      requestedLinearProjectEditFields({
        input: 'Launch',
        description: '',
        content: null,
        members: [],
        priority: 0
      })
    ).toEqual(['description', 'content', 'members', 'priority'])
  })
})

describe('resolveLinearProjectEditIntent', () => {
  it('resolves every reference inside the resolved project workspace', async () => {
    const intent = await resolveLinearProjectEditIntent(
      {
        input: 'Launch',
        status: 'In Progress',
        lead: 'me',
        members: ['ada@example.com', ' ADA@example.com '],
        teams: ['ENG', ' eng '],
        labels: ['Launch'],
        priority: 0
      },
      WORKSPACE_ID
    )

    expect(intent.requested).toEqual(['status', 'lead', 'members', 'teams', 'labels', 'priority'])
    expect(intent.edits).toEqual({
      statusId: 'status-1',
      leadId: USER_ID,
      memberIds: [USER_ID],
      teamIds: [TEAM_ID],
      labelIds: ['label-1'],
      priority: 0
    })
    // Why: repeating one reference must not cost an extra workspace lookup.
    expect(resolveWorkspaceUserForWrite).toHaveBeenCalledTimes(2)
    expect(resolveWorkspaceTeamsForWrite).toHaveBeenCalledWith(['ENG'], WORKSPACE_ID, {})
    expect(resolveProjectStatusForWrite).toHaveBeenCalledWith('In Progress', WORKSPACE_ID, {})
  })

  it('normalizes prose without trimming it and keeps an empty description', async () => {
    const intent = await resolveLinearProjectEditIntent(
      { input: 'Launch', name: '  Aurora  ', description: '', content: '  one\r\ntwo  ' },
      WORKSPACE_ID
    )

    expect(intent.edits).toEqual({ name: 'Aurora', description: '', content: '  one\ntwo  ' })
  })

  it('forwards each clear form untouched and never looks a cleared reference up', async () => {
    const intent = await resolveLinearProjectEditIntent(
      {
        input: 'Launch',
        content: null,
        lead: null,
        members: [],
        labels: [],
        startDate: null,
        targetDate: null
      },
      WORKSPACE_ID
    )

    expect(intent.edits).toEqual({
      content: null,
      leadId: null,
      memberIds: [],
      labelIds: [],
      startDate: null,
      targetDate: null
    })
    expect(resolveWorkspaceUserForWrite).not.toHaveBeenCalled()
    expect(resolveProjectLabelsForWrite).not.toHaveBeenCalled()
  })

  it('rejects a request with no field, a blank name, and an empty team replacement', async () => {
    await expect(resolveLinearProjectEditIntent({ input: 'Launch' }, WORKSPACE_ID)).rejects.toThrow(
      'At least one field to edit is required.'
    )
    await expect(
      resolveLinearProjectEditIntent({ input: 'Launch', name: '   ' }, WORKSPACE_ID)
    ).rejects.toThrow('A Linear project name is required.')
    await expect(
      resolveLinearProjectEditIntent({ input: 'Launch', teams: [] }, WORKSPACE_ID)
    ).rejects.toThrow('A project team replacement needs at least one team.')
    await expect(
      resolveLinearProjectEditIntent({ input: 'Launch', teams: ['   '] }, WORKSPACE_ID)
    ).rejects.toThrow('A project team replacement needs at least one team.')
    expect(resolveWorkspaceTeamsForWrite).not.toHaveBeenCalled()
  })
})
