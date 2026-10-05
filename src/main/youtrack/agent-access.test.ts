import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../shared/worktree/types'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({ baseUrl: 'https://yt.corp' })),
  getIssue: vi.fn(),
  getComments: vi.fn(),
  getStateOptions: vi.fn(),
  setState: vi.fn(),
  listProjects: vi.fn(),
  createIssue: vi.fn(),
  updateField: vi.fn()
}))

vi.mock('./client', () => ({
  getStatus: mocks.getStatus,
  getIssue: mocks.getIssue,
  getComments: mocks.getComments,
  getStateOptions: mocks.getStateOptions,
  setState: mocks.setState,
  addComment: vi.fn(),
  listIssues: vi.fn()
}))
vi.mock('./issue-mutations', () => ({
  listProjects: mocks.listProjects,
  createIssue: mocks.createIssue,
  updateField: mocks.updateField
}))

const {
  createYouTrackIssueForAgents,
  resolveYouTrackIssueId,
  setYouTrackFieldForAgents,
  setYouTrackStateForAgents
} = await import('./agent-access')

function linkedWorktree(youtrackIdentifier: string | null): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution reads only linkedWorkItem; the rest of Worktree is irrelevant here.
  return {
    linkedWorkItem: youtrackIdentifier
      ? { provider: 'youtrack', type: 'issue', number: 0, title: 't', url: 'u', youtrackIdentifier }
      : null
  } as Worktree
}

function runtime(worktree: Worktree | null, terminalWorktreeId = 'wt-1') {
  return {
    showTerminal: vi.fn(async () => ({ worktreeId: terminalWorktreeId })),
    worktreeById: vi.fn(async () => worktree ?? linkedWorktree(null)),
    worktreeForPath: vi.fn(async () => worktree)
  }
}

describe('resolveYouTrackIssueId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts IDs and issue URLs on the connected instance', async () => {
    const rt = runtime(null)
    await expect(resolveYouTrackIssueId({ id: 'proj-81' }, rt)).resolves.toBe('PROJ-81')
    await expect(
      resolveYouTrackIssueId({ id: 'https://yt.corp/issue/PROJ-81/slug' }, rt)
    ).resolves.toBe('PROJ-81')
    await expect(resolveYouTrackIssueId({ id: 'fix login' }, rt)).rejects.toThrow(/not a YouTrack/)
  })

  it('resolves --current from the caller terminal, then from the working directory', async () => {
    const viaTerminal = runtime(linkedWorktree('PROJ-7'))
    await expect(
      resolveYouTrackIssueId({ current: { terminalHandle: 'term-1' } }, viaTerminal)
    ).resolves.toBe('PROJ-7')
    expect(viaTerminal.worktreeById).toHaveBeenCalledWith('wt-1')

    const viaCwd = runtime(linkedWorktree('PROJ-8'))
    await expect(resolveYouTrackIssueId({ current: { cwd: '/repo/wt' } }, viaCwd)).resolves.toBe(
      'PROJ-8'
    )

    const stale = runtime(linkedWorktree('PROJ-9'))
    stale.showTerminal.mockRejectedValue(new Error('terminal_handle_stale'))
    await expect(
      resolveYouTrackIssueId({ current: { terminalHandle: 'gone', cwd: '/repo/wt' } }, stale)
    ).resolves.toBe('PROJ-9')
    await expect(
      resolveYouTrackIssueId({ current: { terminalHandle: 'gone', remote: true } }, stale)
    ).rejects.toThrow(/Could not verify/)
  })

  it('refuses a mismatched worktree hint and unlinked worktrees', async () => {
    await expect(
      resolveYouTrackIssueId(
        { current: { terminalHandle: 'term-1', worktreeId: 'other' } },
        runtime(linkedWorktree('PROJ-7'))
      )
    ).rejects.toThrow(/does not match/)
    await expect(
      resolveYouTrackIssueId({ current: { cwd: '/repo/wt' } }, runtime(linkedWorktree(null)))
    ).rejects.toThrow(/not linked/)
    await expect(resolveYouTrackIssueId({}, runtime(null))).rejects.toThrow(/issue ID/)
  })
})

describe('setYouTrackStateForAgents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('matches the state name case-insensitively and lists choices on a miss', async () => {
    mocks.getStateOptions.mockResolvedValue({
      ok: true,
      options: [
        { id: 'e1', label: 'Fix', kind: 'event' },
        { id: 'e2', label: 'Reopen', kind: 'event' }
      ]
    })
    mocks.setState.mockResolvedValue({ ok: true, issue: { idReadable: 'PROJ-1' } })
    await setYouTrackStateForAgents({ id: 'PROJ-1', state: 'fix' }, runtime(null))
    expect(mocks.setState).toHaveBeenCalledWith({
      idReadable: 'PROJ-1',
      option: { id: 'e1', label: 'Fix', kind: 'event' }
    })
    await expect(
      setYouTrackStateForAgents({ id: 'PROJ-1', state: 'Done' }, runtime(null))
    ).rejects.toThrow('Available: Fix, Reopen.')
  })
})

describe('setYouTrackFieldForAgents', () => {
  it('sends state changes to state set instead of writing the field', async () => {
    mocks.getIssue.mockResolvedValue({
      ok: true,
      issue: { idReadable: 'PROJ-1', stateFieldName: 'State', project: { id: '0-16' } }
    })
    await expect(
      setYouTrackFieldForAgents({ id: 'PROJ-1', name: 'state', values: ['Fixed'] }, runtime(null))
    ).rejects.toThrow(/state set/)
    expect(mocks.updateField).not.toHaveBeenCalled()
  })
})

describe('createYouTrackIssueForAgents', () => {
  it('finds the project by short name, name, or ID', async () => {
    mocks.listProjects.mockResolvedValue({
      ok: true,
      projects: [{ id: '0-16', shortName: 'PROJ', name: 'Project' }]
    })
    mocks.createIssue.mockResolvedValue({ ok: true, issue: { idReadable: 'PROJ-99' } })
    await createYouTrackIssueForAgents({ project: 'proj', summary: 'S' })
    expect(mocks.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: '0-16', summary: 'S', fields: [] })
    )
    await expect(createYouTrackIssueForAgents({ project: 'NOPE', summary: 'S' })).rejects.toThrow(
      /No YouTrack project/
    )
  })
})
