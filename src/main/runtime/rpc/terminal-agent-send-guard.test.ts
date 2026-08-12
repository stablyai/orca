import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function stubRuntime(overrides: Partial<OrcaRuntimeService>): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

function guardedSendRequest(): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.send',
    params: {
      terminal: 'terminal-1',
      enter: true,
      requireAgentStatus: 'sendable',
      client: { id: 'desktop-1', type: 'desktop' }
    }
  }
}

describe('terminal agent send guard', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rechecks a transient no-agent result before refusing a guarded send', async () => {
    vi.useFakeTimers()
    const getTerminalAgentStatus = vi
      .fn()
      .mockResolvedValueOnce({ handle: 'terminal-1', isRunningAgent: false, status: null })
      .mockResolvedValue({ handle: 'terminal-1', isRunningAgent: true, status: 'working' })
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus,
      sendTerminal: vi.fn().mockResolvedValue({
        handle: 'terminal-1',
        accepted: true,
        bytesWritten: 1
      })
    })
    const responsePromise = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatch(
      guardedSendRequest()
    )

    await vi.advanceTimersByTimeAsync(150)

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true, bytesWritten: 1 } }
    })
    expect(getTerminalAgentStatus).toHaveBeenCalledTimes(2)
  })

  it('rechecks a transient no-agent result immediately before the PTY write', async () => {
    vi.useFakeTimers()
    const getTerminalAgentStatus = vi
      .fn()
      .mockResolvedValueOnce({ handle: 'terminal-1', isRunningAgent: true, status: 'working' })
      .mockResolvedValueOnce({ handle: 'terminal-1', isRunningAgent: false, status: null })
      .mockResolvedValue({ handle: 'terminal-1', isRunningAgent: true, status: 'working' })
    const write = vi.fn()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus,
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        await options.beforeWrite('pty-1')
        write()
        return { handle: 'terminal-1', accepted: true, bytesWritten: 1 }
      })
    })
    const responsePromise = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatch(
      guardedSendRequest()
    )

    await vi.advanceTimersByTimeAsync(150)

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true, bytesWritten: 1 } }
    })
    expect(getTerminalAgentStatus).toHaveBeenCalledTimes(3)
    expect(write).toHaveBeenCalledOnce()
  })

  it('still refuses after the bounded recheck window without positive evidence', async () => {
    vi.useFakeTimers()
    const getTerminalAgentStatus = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      isRunningAgent: false,
      status: null
    })
    const sendTerminal = vi.fn()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'desktop' }),
      getTerminalAgentStatus,
      sendTerminal
    })
    const responsePromise = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatch(
      guardedSendRequest()
    )

    await vi.advanceTimersByTimeAsync(1_050)

    await expect(responsePromise).resolves.toMatchObject({
      ok: true,
      result: {
        send: {
          accepted: false,
          bytesWritten: 0,
          refusedReason: 'no-agent'
        }
      }
    })
    expect(getTerminalAgentStatus).toHaveBeenCalledTimes(8)
    expect(sendTerminal).not.toHaveBeenCalled()
  })
})
