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

  it.each([true, false])(
    'rechecks permission before verified submit (blocked=%s)',
    async (blocked) => {
      const controller = new AbortController()
      let permission = false
      const writes: string[] = []
      const runtime = makeRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(true),
        getTerminalAgentStatus: vi.fn(async () => ({
          handle: 'terminal-1',
          isRunningAgent: true,
          status: permission ? ('permission' as const) : ('idle' as const)
        })),
        sendTerminal: vi.fn(),
        sendTerminalAgentPrompt: vi.fn(async (_handle, text, options) => {
          expect(options?.signal).toBe(controller.signal)
          await options?.beforeWrite?.('pty-1')
          writes.push(text)
          permission = blocked
          await options?.beforeWrite?.('pty-1')
          writes.push('submit')
          return { handle: 'terminal-1', accepted: true, bytesWritten: text.length + 1 }
        })
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const response = await dispatcher.dispatch(
        makeRequest({
          terminal: 'terminal-1',
          text: 'review this',
          enter: true,
          agentPrompt: true,
          requireAgentStatus: 'sendable',
          client: { id: 'orca-desktop', type: 'desktop' }
        }),
        { signal: controller.signal }
      )
      expect(response).toMatchObject({ ok: true, result: { send: { accepted: !blocked } } })
      expect(writes).toEqual(blocked ? ['review this'] : ['review this', 'submit'])
      expect(runtime.sendTerminal).not.toHaveBeenCalled()
    }
  )

  it('refuses combined guarded input when settlement support disappeared', async () => {
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      sendTerminal: vi.fn(),
      sendTerminalAgentPrompt: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'review this',
        enter: true,
        agentPrompt: true,
        requireAgentStatus: 'sendable',
        client: { id: 'orca-desktop', type: 'desktop' }
      })
    )
    expect(response).toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
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
