import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal send RPC', () => {
  it('reports whether a terminal handle is running a recognized agent', async () => {
    const runtime = stubRuntime({
      isTerminalRunningAgent: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.isRunningAgent', {
        terminal: 'terminal-1'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({ isRunningAgent: true })
    expect(runtime.isTerminalRunningAgent).toHaveBeenCalledWith('terminal-1')
  })

  it('reports runtime-owned terminal agent status', async () => {
    const runtime = stubRuntime({
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'permission'
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.agentStatus', {
        terminal: 'terminal-1'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      agentStatus: {
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'permission'
      }
    })
    expect(runtime.getTerminalAgentStatus).toHaveBeenCalledWith('terminal-1')
  })

  it('drops desktop input while a mobile client owns the terminal floor', async () => {
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      sendTerminal: vi.fn(),
      mobileTookFloor: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'x',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0
      }
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(runtime.mobileTookFloor).not.toHaveBeenCalled()
  })

  it('accepts legacy clientless mobile input when the current driver is mobile', async () => {
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 1
      }),
      mobileTookFloor: vi.fn().mockResolvedValue(undefined)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'x'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({ send: { accepted: true, bytesWritten: 1 } })
    expect(runtime.sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      {
        text: 'x',
        enter: false,
        interrupt: false
      },
      { beforeWrite: undefined }
    )
    expect(runtime.mobileTookFloor).toHaveBeenCalledWith('pty-1', 'mobile-1')
  })

  it('refuses guarded terminal sends when the agent needs permission', async () => {
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'permission'
      }),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0,
        refusedReason: 'permission'
      }
    })
    expect(runtime.getTerminalAgentStatus).toHaveBeenCalledWith('terminal-1')
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('allows guarded terminal sends when the agent is sendable', async () => {
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'working'
      }),
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 1
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toMatchObject({ send: { accepted: true, bytesWritten: 1 } })
    expect(runtime.sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      {
        text: undefined,
        enter: true,
        interrupt: false
      },
      { beforeWrite: expect.any(Function) }
    )
  })

  it('refuses guarded combined text and submit sends before any PTY write', async () => {
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus: vi.fn(),
      sendTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        text: 'notes',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0
      }
    })
    expect(runtime.getTerminalAgentStatus).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('rechecks the mobile floor lock immediately before guarded PTY writes', async () => {
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi
        .fn()
        .mockReturnValueOnce({ kind: 'desktop' })
        .mockReturnValueOnce({ kind: 'desktop' })
        .mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' }),
      getTerminalAgentStatus: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        isRunningAgent: true,
        status: 'working'
      }),
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        await options.beforeWrite('pty-1')
        return { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.send', {
        terminal: 'terminal-1',
        enter: true,
        requireAgentStatus: 'sendable',
        client: { id: 'desktop-1', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      send: {
        handle: 'terminal-1',
        accepted: false,
        bytesWritten: 0
      }
    })
  })

  it('routes terminal restore fit through the runtime driver state machine', async () => {
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      reclaimTerminalForDesktop: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('terminal.restoreFit', {
        terminal: 'terminal-1'
      })
    )

    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({ restored: true })
    expect(runtime.reclaimTerminalForDesktop).toHaveBeenCalledWith('pty-1')
  })
})
