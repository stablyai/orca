import { describe, expect, it, vi } from 'vitest'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { dispatchRemoteLinearListIssues } from './ssh-remote-linear-list-issues'

describe('SSH Linear MCP-compatible issue listing', () => {
  it('dispatches the same filter and pagination contract as the local CLI', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      id: 'response-1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
    const dispatcher = { dispatch } as unknown as RpcDispatcher

    await dispatchRemoteLinearListIssues(dispatcher, {
      commandPath: ['linear', 'list-issues'],
      flags: new Map<string, string | boolean>([
        ['team', 'ENG'],
        ['cycle', 'Cycle 1'],
        ['label', 'Bug'],
        ['limit', '100'],
        ['query', 'auth'],
        ['state', 'In Progress'],
        ['cursor', 'next-page'],
        ['order-by', 'createdAt'],
        ['project', 'Launch'],
        ['release', 'v1'],
        ['assignee', 'me'],
        ['delegate', 'agent-1'],
        ['parent-id', 'issue-parent'],
        ['priority', '2'],
        ['created-at', '-P30D'],
        ['updated-at', '-P7D'],
        ['include-archived', true],
        ['workspace', 'workspace-1'],
        ['json', true]
      ])
    })

    expect(dispatch).toHaveBeenCalledWith({
      id: expect.stringMatching(/^remote-cli-/),
      authToken: 'remote-cli',
      method: 'linear.mcpListIssues',
      params: {
        team: 'ENG',
        cycle: 'Cycle 1',
        label: 'Bug',
        limit: 100,
        query: 'auth',
        state: 'In Progress',
        cursor: 'next-page',
        orderBy: 'createdAt',
        project: 'Launch',
        release: 'v1',
        assignee: 'me',
        delegate: 'agent-1',
        parentId: 'issue-parent',
        priority: 2,
        createdAt: '-P30D',
        updatedAt: '-P7D',
        includeArchived: true,
        workspaceId: 'workspace-1'
      }
    })
  })

  it('rejects zero limits before RPC dispatch like the local CLI', async () => {
    const dispatch = vi.fn()
    const dispatcher = { dispatch } as unknown as RpcDispatcher

    await expect(
      dispatchRemoteLinearListIssues(dispatcher, {
        commandPath: ['linear', 'list-issues'],
        flags: new Map([['limit', '0']])
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Invalid positive integer for --limit'
    })
    expect(dispatch).not.toHaveBeenCalled()
  })
})
