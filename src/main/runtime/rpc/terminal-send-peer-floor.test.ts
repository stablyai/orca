import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    beginInputFloor: vi.fn((ptyId: string, clientId: string) => ({
      commit: async () => {
        await overrides.mobileTookFloor?.(ptyId, clientId)
      },
      rollback: vi.fn()
    })),
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal send RPC peer input floor', () => {
  it('exempts the driving peer itself from its own input-floor lock', async () => {
    const sendTerminal = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 1
    })
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      // Why: the peer that itself claimed the floor (source: 'peer') is the driver.
      getDriver: vi.fn().mockReturnValue({ kind: 'peer', clientId: 'peer-A' }),
      sendTerminal
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'peer-A', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
    })
    expect(runtime.sendTerminal).toHaveBeenCalled()
  })

  it('locks out a non-driving peer while another peer holds the input floor', async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'peer', clientId: 'peer-A' }),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'peer-B', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 }
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })
})
