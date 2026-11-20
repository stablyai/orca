import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal/terminal'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal signal RPC', () => {
  it('forwards the signal to the runtime with the terminal handle', async () => {
    const runtime = stubRuntime({
      sendTerminalSignal: vi.fn().mockResolvedValue({ handle: 'terminal-1', signaled: true })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.signal', {
        terminal: 'terminal-1',
        signal: 'SIGINT'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      signal: { handle: 'terminal-1', signaled: true }
    })
    expect(runtime.sendTerminalSignal).toHaveBeenCalledWith('terminal-1', 'SIGINT')
  })

  it('refuses a signal request without a signal name', async () => {
    const runtime = stubRuntime({
      sendTerminalSignal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.signal', {
        terminal: 'terminal-1'
      })
    )

    expect(response.ok).toBe(false)
    expect(runtime.sendTerminalSignal).not.toHaveBeenCalled()
  })
})
