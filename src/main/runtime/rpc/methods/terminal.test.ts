import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TERMINAL_METHODS } from './terminal'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

/** Dispatch a non-streaming method through the streaming path so the
 *  authenticated clientKind reaches the handler, and return the parsed result. */
async function dispatchWithClientKind(
  dispatcher: RpcDispatcher,
  request: RpcRequest,
  clientKind?: 'mobile' | 'runtime'
): Promise<{ ok: boolean; result?: unknown }> {
  const messages: string[] = []
  await dispatcher.dispatchStreaming(request, (m) => messages.push(m), { clientKind })
  return JSON.parse(messages[0]!)
}

const AGENT_LAUNCH = { selection: { kind: 'agent', agent: 'claude' }, prompt: 'hi' }

describe('terminal.create host-resolved agentLaunch', () => {
  it('forwards agentLaunch + clientKind and returns the created terminal', async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      handle: 'h-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      title: null,
      surface: 'background',
      agentLaunch: { status: 'launched', receipt: { baseAgent: 'claude' } }
    })
    const runtime = { getRuntimeId: () => 'r', createTerminal } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatchWithClientKind(
      dispatcher,
      makeRequest('terminal.create', {
        worktree: 'id:wt-1',
        command: 'evil --client-controlled',
        agentLaunch: AGENT_LAUNCH
      }),
      'mobile'
    )

    expect(response.ok).toBe(true)
    expect(createTerminal).toHaveBeenCalledTimes(1)
    expect(createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ agentLaunch: AGENT_LAUNCH, clientKind: 'mobile' })
    )
    expect(response.result).toMatchObject({ terminal: { handle: 'h-1' } })
  })

  it('returns the failure arm as an RPC success with no terminal created', async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      agentLaunch: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    })
    const runtime = { getRuntimeId: () => 'r', createTerminal } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatchWithClientKind(
      dispatcher,
      makeRequest('terminal.create', { worktree: 'id:wt-1', agentLaunch: AGENT_LAUNCH }),
      'runtime'
    )

    expect(response.ok).toBe(true)
    expect(response.result).toEqual({
      agentLaunch: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    })
    expect(response.result).not.toHaveProperty('terminal')
  })

  it('leaves the legacy (no-agentLaunch) path forwarding the client command unchanged', async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      handle: 'h-2',
      worktreeId: 'wt-1',
      title: null,
      surface: 'background'
    })
    const runtime = { getRuntimeId: () => 'r', createTerminal } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatchWithClientKind(
      dispatcher,
      makeRequest('terminal.create', { worktree: 'id:wt-1', command: 'zsh' })
    )

    expect(response.ok).toBe(true)
    expect(response.result).toMatchObject({ terminal: { handle: 'h-2' } })
    const call = createTerminal.mock.calls[0]![1]
    expect(call.command).toBe('zsh')
    expect(call).not.toHaveProperty('agentLaunch')
  })
})
