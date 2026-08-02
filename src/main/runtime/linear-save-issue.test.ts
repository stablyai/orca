import { afterEach, describe, expect, it, vi } from 'vitest'
import { LINEAR_WRITE_BODY_CAP } from '../../shared/linear-agent-access'
import * as linearTeams from '../linear/teams'
import { OrcaRuntimeService } from './orca-runtime'

const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Existing title',
  description: 'Existing description',
  url: 'https://linear.app/acme/issue/ENG-1',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-1', name: 'Todo' },
  parent: null,
  project: null,
  assignee: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  labels: []
}

type SaveIssueInternals = {
  resolveLinearAssignee(input: string, teamId: string, workspaceId: string): Promise<string>
  resolveLinearAgentState(input: string, states: unknown[]): unknown | null
  buildLinearSaveUpdate(
    params: { labels?: string[] },
    current: typeof issue,
    workspaceId: string
  ): Promise<{ labelIds?: string[] }>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Linear save issue', () => {
  it('delegates creates with the MCP-required team and title', async () => {
    const runtime = new OrcaRuntimeService()
    const create = vi.spyOn(runtime, 'linearIssueCreate').mockResolvedValue({
      issue,
      meta: { workspaceId: 'workspace-1', writeId: 'write-1', deduplicated: false }
    })

    await expect(
      runtime.linearSaveIssue({ team: 'ENG', title: 'New issue', workspaceId: 'workspace-1' })
    ).resolves.toMatchObject({ meta: { created: true } })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        teamInput: 'ENG',
        title: 'New issue',
        workspaceId: 'workspace-1'
      })
    )
  })

  it('keeps team changes explicitly unsupported on updates', async () => {
    const runtime = new OrcaRuntimeService()

    await expect(
      runtime.linearSaveIssue({ input: 'ENG-1', team: 'OPS', title: 'Moved issue' })
    ).rejects.toMatchObject({
      code: 'linear_write_failed',
      message: 'Team can only be set when creating an issue.'
    })
  })

  it('rejects oversized descriptions before resolving an issue or calling Linear', async () => {
    const runtime = new OrcaRuntimeService()
    const resolveTarget = vi.fn()
    Object.assign(runtime, { resolveLinearAgentWriteTarget: resolveTarget })

    await expect(
      runtime.linearSaveIssue({
        input: 'ENG-1',
        description: 'x'.repeat(LINEAR_WRITE_BODY_CAP + 1)
      })
    ).rejects.toMatchObject({ code: 'linear_body_too_large' })
    expect(resolveTarget).not.toHaveBeenCalled()
  })

  it('does not send a mutation or confirmation read when every field is already set', async () => {
    const runtime = new OrcaRuntimeService()
    const runWrite = vi.fn()
    const notify = vi.fn().mockResolvedValue(undefined)
    Object.assign(runtime, {
      resolveLinearAgentWriteTarget: vi
        .fn()
        .mockResolvedValue({ issue, workspaceId: 'workspace-1' }),
      readLinearAgentIssueWriteRecord: vi.fn().mockResolvedValue(issue),
      buildLinearSaveUpdate: vi.fn().mockResolvedValue({ title: issue.title }),
      runLinearAgentWrite: runWrite,
      notifyLinearLinkedIssueUpdated: notify
    })

    await expect(
      runtime.linearSaveIssue({ input: issue.identifier, title: issue.title })
    ).resolves.toMatchObject({ issue, meta: { created: false } })

    expect(runWrite).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('workspace-1', issue.identifier)
  })

  it('accepts user UUIDs without listing every team member', async () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    const listMembers = vi.spyOn(linearTeams, 'getTeamMembersOrThrow')
    const userId = '11111111-1111-4111-8111-111111111111'

    await expect(runtime.resolveLinearAssignee(userId, 'team-1', 'workspace-1')).resolves.toBe(
      userId
    )
    expect(listMembers).not.toHaveBeenCalled()
  })

  it('matches assignees by full name or email like Linear MCP', async () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    vi.spyOn(linearTeams, 'getTeamMembersOrThrow').mockResolvedValue([
      {
        id: 'user-1',
        displayName: 'Ada',
        name: 'Ada Lovelace',
        email: 'ada@example.com'
      }
    ])

    await expect(
      runtime.resolveLinearAssignee('Ada Lovelace', 'team-1', 'workspace-1')
    ).resolves.toBe('user-1')
    await expect(
      runtime.resolveLinearAssignee('ADA@EXAMPLE.COM', 'team-1', 'workspace-1')
    ).resolves.toBe('user-1')
  })

  it('resolves workflow lifecycle types while preferring exact state names', () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    const states = [
      { id: 'state-progress', name: 'In Progress', type: 'started' },
      { id: 'state-started', name: 'Started', type: 'unstarted' }
    ]

    expect(runtime.resolveLinearAgentState('started', states)).toBe(states[1])
    expect(runtime.resolveLinearAgentState('unstarted', states)).toBe(states[1])
  })

  it('clears labels without listing the team label catalog', async () => {
    const runtime = new OrcaRuntimeService() as unknown as SaveIssueInternals
    const listLabels = vi.spyOn(linearTeams, 'getTeamLabelsOrThrow')

    await expect(
      runtime.buildLinearSaveUpdate({ labels: [] }, issue, 'workspace-1')
    ).resolves.toEqual({ labelIds: [] })
    expect(listLabels).not.toHaveBeenCalled()
  })
})
