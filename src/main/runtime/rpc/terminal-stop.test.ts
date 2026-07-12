import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

describe('terminal stop RPC', () => {
  it('uses the generic graceful worktree-stop mode', async () => {
    const stopTerminalsForWorktree = vi.fn().mockResolvedValue({ stopped: 2 })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      stopTerminalsForWorktree
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'terminal.stop',
      params: { worktree: 'repo-1::/worktree' }
    }

    const response = await dispatcher.dispatch(request)

    expect(response.ok).toBe(true)
    expect(stopTerminalsForWorktree).toHaveBeenCalledWith('repo-1::/worktree')
  })
})
