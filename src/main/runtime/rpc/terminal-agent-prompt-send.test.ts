import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { TERMINAL_METHODS } from './methods/terminal'

vi.mock('../../git/worktree', () => ({
  listWorktreesStrict: async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
  ]
}))

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
      inputKind: 'driving',
      inputSource: 'programmatic',
      beforeWrite: undefined,
      observationSignal: undefined
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
      expect.objectContaining({ inputKind: 'driving', inputSource: 'programmatic' })
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

  it.each([false, true])(
    'refuses desktop input after late phone takeover (prompt=%s)',
    async (agentPrompt) => {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        () => {},
        'claude'
      )
      const selecting = Promise.withResolvers<void>()
      const release = Promise.withResolvers<boolean>()
      vi.spyOn(runtime, 'isTerminalRunningSettledPromptAgent').mockImplementation(() => {
        selecting.resolve()
        return release.promise
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const sending = dispatcher.dispatch(
        makeRequest({
          terminal: handle,
          text: 'first',
          enter: true,
          agentPrompt: true,
          client: { id: 'desktop-1', type: 'desktop' }
        }),
        { caller: { kind: 'paired-device', deviceId: 'desktop-pair' } }
      )
      await selecting.promise
      await runtime.handleMobileSubscribe('pty-prompt', 'phone-A', { cols: 45, rows: 20 })
      release.resolve(agentPrompt)
      await expect(sending).resolves.toMatchObject({
        ok: true,
        result: { send: { handle, accepted: false, bytesWritten: 0 } }
      })
      expect(writes).toEqual([])
    }
  )
})
