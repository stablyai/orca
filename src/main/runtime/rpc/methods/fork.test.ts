import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FORK_METHODS } from './fork'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('fork RPC methods', () => {
  it('routes fork preflight options to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      preflightAgentSessionFork: vi.fn().mockResolvedValue({ sourceWorktreeId: 'wt-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FORK_METHODS })

    await dispatcher.dispatch(
      makeRequest('fork.preflight', {
        terminal: 'term-1',
        message: 'opencode-message-1',
        noCopyFiles: true
      })
    )

    expect(runtime.preflightAgentSessionFork).toHaveBeenCalledWith({
      terminalHandle: 'term-1',
      worktreeSelector: undefined,
      agent: undefined,
      providerSession: undefined,
      forkPoint: { kind: 'message', id: 'opencode-message-1' },
      noCopyFiles: true
    })
  })

  it('routes fork create options to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAgentSessionFork: vi.fn().mockResolvedValue({ fork: { id: 'fork-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FORK_METHODS })

    await dispatcher.dispatch(
      makeRequest('fork.create', {
        terminal: 'term-1',
        name: 'child',
        message: 'opencode-message-1',
        activate: true,
        noCopyFiles: true
      })
    )

    expect(runtime.createAgentSessionFork).toHaveBeenCalledWith({
      terminalHandle: 'term-1',
      name: 'child',
      activate: true,
      forkPoint: { kind: 'message', id: 'opencode-message-1' },
      noCopyFiles: true
    })
  })

  it('routes provider-session fork create options to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createAgentSessionFork: vi.fn().mockResolvedValue({ fork: { id: 'fork-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FORK_METHODS })

    await dispatcher.dispatch(
      makeRequest('fork.create', {
        worktree: 'id:wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        message: 'claude-message-1',
        promptInteractions: [
          {
            id: 'claude-message-1',
            prompt: 'first prompt',
            observedAt: 1_000,
            agentType: 'claude'
          }
        ]
      })
    )

    expect(runtime.createAgentSessionFork).toHaveBeenCalledWith({
      terminalHandle: undefined,
      worktreeSelector: 'id:wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' },
      promptInteractions: [
        {
          id: 'claude-message-1',
          prompt: 'first prompt',
          observedAt: 1_000,
          agentType: 'claude'
        }
      ],
      forkPoint: { kind: 'message', id: 'claude-message-1' },
      name: undefined,
      activate: undefined,
      noCopyFiles: false
    })
  })

  it('routes fork collection methods to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listAgentSessionForks: vi.fn().mockResolvedValue({ forks: [] }),
      showAgentSessionFork: vi.fn().mockResolvedValue({ fork: { id: 'fork-1' } }),
      diffAgentSessionFork: vi.fn().mockResolvedValue({ fork: { id: 'fork-1' }, diff: '' }),
      removeAgentSessionFork: vi.fn().mockResolvedValue({ forkId: 'fork-1', removed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FORK_METHODS })

    await dispatcher.dispatch(makeRequest('fork.list', { worktree: 'id:parent', limit: 10 }))
    await dispatcher.dispatch(makeRequest('fork.show', { fork: 'child' }))
    await dispatcher.dispatch(makeRequest('fork.diff', { fork: 'child' }))
    await dispatcher.dispatch(makeRequest('fork.rm', { fork: 'child', force: true }))

    expect(runtime.listAgentSessionForks).toHaveBeenCalledWith({
      worktreeSelector: 'id:parent',
      limit: 10
    })
    expect(runtime.showAgentSessionFork).toHaveBeenCalledWith('child')
    expect(runtime.diffAgentSessionFork).toHaveBeenCalledWith('child')
    expect(runtime.removeAgentSessionFork).toHaveBeenCalledWith('child', true, false)
  })
})
