import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'request', authToken: 'token', method: 'terminal.send', params }
}

function makeRuntime(overrides: Partial<OrcaRuntimeService>): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

describe('terminal agent prompt send RPC', () => {
  it('routes an explicit CLI agent prompt through settled prompt delivery', async () => {
    const sendTerminal = vi.fn()
    const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 19
    })
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(true),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'review this change',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.isTerminalRunningSettledPromptAgent).toHaveBeenCalledWith('terminal-1')
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith('terminal-1', 'review this change', {
      beforeWrite: undefined,
      signal: undefined
    })
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('preserves direct input when the CLI target is not a proven settlement agent', async () => {
    const sendTerminal = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 7
    })
    const sendTerminalAgentPrompt = vi.fn()
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'echo x',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      { text: 'echo x', enter: true, interrupt: false },
      { beforeWrite: undefined, signal: undefined }
    )
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('forwards the request signal to a plain send so an abandoned call stops before Enter', async () => {
    const sendTerminal = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 7
    })
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      sendTerminal
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const controller = new AbortController()

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'echo x',
        enter: true,
        client: { id: 'orca-cli', type: 'desktop' }
      }),
      { signal: controller.signal }
    )

    expect(response.ok).toBe(true)
    expect(sendTerminal.mock.calls[0][2].signal).toBe(controller.signal)
  })
})
