import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import {
  handleRequest,
  type RpcRequest,
  type RpcResponse
} from '../scripts/mock-server-rpc-handlers'

function callRpc(method: string, params?: Record<string, unknown>): RpcResponse {
  let response: RpcResponse | undefined
  const request: RpcRequest = { id: 'request-1', method, ...(params ? { params } : {}) }
  handleRequest(
    request,
    (nextResponse) => {
      response = nextResponse
    },
    {} as WebSocket
  )
  expect(response).toBeDefined()
  return response!
}

function listSessionTabs(worktree: string): RpcResponse {
  return callRpc('session.tabs.list', { worktree })
}

describe('mock server session tabs fixture', () => {
  it('returns a contract-complete terminal surface for the requested worktree', () => {
    const response = listSessionTabs('id:repo-1::worktree-1')

    expect(response.result).toEqual({
      worktree: 'repo-1::worktree-1',
      publicationEpoch: expect.stringMatching(/^mock-server:/),
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: 'tab-1::f47ac10b-58cc-4372-a567-0e02b2c3d479',
      activeTabType: 'terminal',
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'tab-1',
          tabOrder: ['tab-1'],
          recentTabIds: ['tab-1']
        }
      ],
      tabs: [
        {
          type: 'terminal',
          id: 'tab-1::f47ac10b-58cc-4372-a567-0e02b2c3d479',
          title: 'zsh',
          parentTabId: 'tab-1',
          leafId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          status: 'ready',
          terminal: 'term-1',
          isActive: true
        }
      ]
    })
  })

  it('passes a bare worktree selector through unprefixed', () => {
    const response = listSessionTabs('repo-1::worktree-1')

    expect((response.result as { worktree: string }).worktree).toBe('repo-1::worktree-1')
  })

  it('falls back to the same worktree terminal.list uses when no selector is sent', () => {
    const terminals = callRpc('terminal.list').result as {
      terminals: { worktreeId: string }[]
    }
    const expected = terminals.terminals[0]?.worktreeId
    expect(expected).toBeTruthy()

    const tabs = callRpc('session.tabs.list').result as { worktree: string }
    expect(tabs.worktree).toBe(expected)
  })
})
