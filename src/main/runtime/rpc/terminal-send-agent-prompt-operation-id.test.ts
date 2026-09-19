import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

describe('settled agent-prompt operation identity', () => {
  it('forwards the terminal.send operation identity to prompt delivery', async () => {
    const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 1
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(true),
      sendTerminalAgentPrompt
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'token',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: 'review this',
        enter: true,
        agentPrompt: true,
        operationId: 'agent-prompt-op-1',
        client: { id: 'desktop-1', type: 'desktop' }
      }
    }

    const response = await dispatcher.dispatch(request)

    expect(response.ok).toBe(true)
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'terminal-1',
      'review this',
      expect.objectContaining({ operationId: 'agent-prompt-op-1' })
    )
  })
})
