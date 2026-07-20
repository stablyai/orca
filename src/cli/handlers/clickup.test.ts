import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { CLICKUP_HANDLERS } from './clickup'

describe('orca clickup CLI handlers', () => {
  const call = vi.fn()
  const client = { call, isRemote: false } as unknown as RuntimeClient
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

  beforeEach(() => {
    call.mockReset()
    log.mockClear()
  })

  afterEach(() => {
    delete process.env.ORCA_WORKTREE_ID
  })

  it('reads the ClickUp task linked to the current worktree', async () => {
    process.env.ORCA_WORKTREE_ID = 'repo-1::/tmp/worktree'
    call
      .mockResolvedValueOnce({
        result: {
          worktree: {
            linkedClickUpTaskId: '86abc123',
            linkedClickUpWorkspaceId: 'team-1'
          }
        }
      })
      .mockResolvedValueOnce({
        result: {
          id: '86abc123',
          workspaceId: 'team-1',
          name: 'Fix auth',
          status: { name: 'open' },
          list: { name: 'Backlog' },
          assignees: [],
          tags: [],
          url: 'https://app.clickup.com/t/86abc123',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      })

    await CLICKUP_HANDLERS['clickup task']({
      flags: new Map([['current', true]]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'worktree.show', {
      worktree: 'id:repo-1::/tmp/worktree'
    })
    expect(call).toHaveBeenNthCalledWith(2, 'clickup.getTask', {
      taskId: '86abc123',
      workspaceId: 'team-1'
    })
  })

  it('maps human priority names onto ClickUp priority IDs', async () => {
    call.mockResolvedValueOnce({ result: { ok: true } })

    await CLICKUP_HANDLERS['clickup priority set']({
      flags: new Map([
        ['id', '86abc123'],
        ['to', 'high'],
        ['workspace', 'team-1']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('clickup.updateTask', {
      taskId: '86abc123',
      workspaceId: 'team-1',
      updates: { priority: 2 }
    })
  })

  it('creates a task with the selected List and Workspace', async () => {
    call.mockResolvedValueOnce({ result: { ok: false, error: 'No access' } })

    await CLICKUP_HANDLERS['clickup create']({
      flags: new Map([
        ['list', 'list-1'],
        ['title', 'Fix auth'],
        ['body', 'Details'],
        ['workspace', 'team-1']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('clickup.createTask', {
      listId: 'list-1',
      name: 'Fix auth',
      description: 'Details',
      status: undefined,
      priority: undefined,
      dueDate: undefined,
      workspaceId: 'team-1'
    })
  })

  it('normalizes task filters case-insensitively', async () => {
    call.mockResolvedValueOnce({ result: [] })

    await CLICKUP_HANDLERS['clickup list']({
      flags: new Map([['filter', 'Assigned']]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('clickup.listTasks', {
      filter: 'assigned',
      limit: undefined,
      workspaceId: undefined
    })
  })

  it('prints a comment-specific success message', async () => {
    call.mockResolvedValueOnce({ result: { ok: true } })

    await CLICKUP_HANDLERS['clickup comment add']({
      flags: new Map([
        ['id', '86abc123'],
        ['body', 'Ready for review']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(log).toHaveBeenCalledWith('Added comment to ClickUp task.')
  })

  it.each([
    new Map<string, string | boolean>([
      ['id', '86abc123'],
      ['current', true],
      ['to', 'high']
    ]),
    new Map<string, string | boolean>([['to', 'high']])
  ])('rejects ambiguous or missing task selectors', async (flags) => {
    await expect(
      CLICKUP_HANDLERS['clickup priority set']({
        flags,
        client,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['clickup list', new Map([['filter', 'unknown']])],
    [
      'clickup priority set',
      new Map([
        ['id', '86abc123'],
        ['to', 'critical']
      ])
    ],
    [
      'clickup due-date set',
      new Map([
        ['id', '86abc123'],
        ['to', '2026-02-30']
      ])
    ]
  ])('rejects invalid ClickUp command values', async (handler, flags) => {
    await expect(
      CLICKUP_HANDLERS[handler]({
        flags,
        client,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects --current when the worktree is not linked to ClickUp', async () => {
    process.env.ORCA_WORKTREE_ID = 'repo-1::/tmp/worktree'
    call.mockResolvedValueOnce({ result: { worktree: {} } })

    await expect(
      CLICKUP_HANDLERS['clickup task']({
        flags: new Map([['current', true]]),
        client,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({ code: 'selector_not_found' })
  })
})
