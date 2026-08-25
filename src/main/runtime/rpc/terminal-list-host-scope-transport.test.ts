import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

// Request options in this codebase have been dropped by a transport that
// forgot to forward them. The host-scope answer must survive the RPC boundary
// the same way, so assert it on the far side of the dispatcher.
const LIST_RESULT: RuntimeTerminalListResult = {
  terminals: [
    {
      handle: 'term_remote',
      ptyId: 'ssh:box-1@@pty-7',
      worktreeId: 'repo-ssh::/remote/wt',
      worktreePath: '/remote/wt',
      branch: 'main',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      title: 'worker',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      executionHostId: 'ssh:box-1'
    }
  ],
  totalCount: 1,
  truncated: false,
  hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: ['local'] }
}

describe('terminal.list RPC boundary', () => {
  it('forwards the execution host and scope the runtime reported', async () => {
    const runtime = {
      listTerminals: vi.fn(async () => LIST_RESULT),
      getRuntimeId: () => 'runtime-a'
    }
    const dispatcher = new RpcDispatcher({ runtime: runtime as never, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch({
      id: 'request-1',
      authToken: 'test-token',
      method: 'terminal.list',
      params: {}
    })

    expect(response.ok).toBe(true)
    const result = (response as { result: RuntimeTerminalListResult }).result
    expect(result.terminals[0]?.executionHostId).toBe('ssh:box-1')
    expect(result.hostScope).toEqual({ hostIds: ['ssh:box-1'], omittedHostIds: ['local'] })
  })
})
