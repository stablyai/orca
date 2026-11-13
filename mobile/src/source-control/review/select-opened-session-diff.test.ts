import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { selectOpenedSessionDiff } from './select-opened-session-diff'

function ok(result: unknown): RpcResponse {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

describe('selectOpenedSessionDiff', () => {
  it('selects the opened diff for this phone once the desktop lists it', async () => {
    vi.useFakeTimers()
    try {
      let lists = 0
      const sendRequest = vi.fn(async (method: string, _params?: unknown) => {
        if (method === 'session.tabs.list') {
          lists += 1
          return ok({
            tabs:
              lists === 1
                ? []
                : [
                    {
                      id: 'staged',
                      type: 'file',
                      mode: 'diff',
                      relativePath: 'a.ts',
                      diffSource: 'staged'
                    },
                    { id: 'edit', type: 'file', mode: 'edit', relativePath: 'a.ts' },
                    { id: 'branch', type: 'file', mode: 'diff', relativePath: 'a.ts' },
                    {
                      id: 'unstaged',
                      type: 'file',
                      mode: 'diff',
                      relativePath: 'a.ts',
                      diffSource: 'unstaged'
                    }
                  ]
          })
        }
        return ok({ activeTabId: 'unstaged' })
      })
      const selecting = selectOpenedSessionDiff(
        { sendRequest } as unknown as RpcClient,
        {
          worktreeId: 'wt-1',
          relativePath: 'a.ts',
          staged: false
        },
        () => true
      )
      await vi.runAllTimersAsync()
      await selecting

      expect(
        sendRequest.mock.calls.filter(([method]) => method === 'session.tabs.activate')
      ).toEqual([
        [
          'session.tabs.activate',
          {
            worktree: 'id:wt-1',
            tabId: 'unstaged',
            notifyClients: false,
            navigation: 'caller',
            intent: 'user'
          }
        ]
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
