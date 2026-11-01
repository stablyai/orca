import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../src/shared/stable-pane-id'
import type { RpcResponse } from '../transport/types'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { closeHostSidebarSession, closeSidebarSession } from './sidebar-session-close'

const LEAF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE = makePaneKey('parent', LEAF)

function client(
  respond: (method: string, params: unknown) => RpcResponse
): UnvalidatedRpcRequestPort {
  return {
    sendRequest(method, params) {
      return Promise.resolve(respond(method, params))
    }
  }
}

const terminalList = {
  id: 'list',
  ok: true as const,
  result: {
    tabs: [{ type: 'terminal', id: 'leaf-row', parentTabId: 'parent', leafId: LEAF }]
  }
}

describe('closeSidebarSession', () => {
  it('closes the tab the pane names', async () => {
    const calls: unknown[] = []
    const outcome = await closeSidebarSession(
      client((method, params) => {
        calls.push({ method, params })
        if (method === 'session.tabs.list') {
          return terminalList
        }
        return { id: 'close', ok: true, result: { closed: true, retirementConfirmed: true } }
      }),
      'wt-1',
      PANE
    )
    expect(outcome).toBe('closed')
    expect(calls).toEqual([
      { method: 'session.tabs.list', params: { worktree: 'id:wt-1' } },
      {
        method: 'session.tabs.close',
        params: { worktree: 'id:wt-1', tabId: 'leaf-row', reason: 'user' }
      }
    ])
  })

  it('does not close when that pane is gone', async () => {
    const methods: string[] = []
    const outcome = await closeSidebarSession(
      client((method) => {
        methods.push(method)
        return { id: 'list', ok: true, result: { tabs: [] } }
      }),
      'wt-1',
      PANE
    )
    expect(outcome).toBe('missing')
    expect(methods).toEqual(['session.tabs.list'])
  })

  it('reports a refused close and a failed list separately', async () => {
    const refused = await closeSidebarSession(
      client((method) =>
        method === 'session.tabs.list'
          ? terminalList
          : { id: 'close', ok: true, result: { refused: true } }
      ),
      'wt-1',
      PANE
    )
    const failed = await closeSidebarSession(
      client(() => ({ id: 'list', ok: false, error: { code: 'unavailable', message: 'down' } })),
      'wt-1',
      PANE
    )
    expect(refused).toBe('refused')
    expect(failed).toBe('failed')
  })

  it('fails when the host client is missing or the snapshot is not a tab list', async () => {
    expect(await closeHostSidebarSession(null, [], { worktreeId: 'wt-1' }, PANE)).toBe('failed')
    const outcome = await closeSidebarSession(
      client(() => ({ id: 'list', ok: true, result: { tabs: 'no' } })),
      'wt-1',
      PANE
    )
    expect(outcome).toBe('failed')
  })
})
