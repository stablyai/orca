import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

describe('terminal list RPC', () => {
  it('forwards repo scope with the worktree selector and list options', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listTerminals: vi.fn().mockResolvedValue({ terminals: [], totalCount: 0, truncated: false })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'terminal.list',
      params: {
        worktree: 'id:repo-a::/worktree',
        repo: 'id:repo-a',
        limit: 5,
        requireFreshPtyLiveness: true
      }
    }

    await dispatcher.dispatch(request)

    expect(runtime.listTerminals).toHaveBeenCalledWith('id:repo-a::/worktree', 5, {
      repoSelector: 'id:repo-a',
      requireFreshPtyLiveness: true
    })
  })
})
