import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

function makeRuntime(send: Record<string, unknown>) {
  const sendTerminal = vi.fn().mockResolvedValue(send)
  const runtime = {
    getRuntimeId: () => 'runtime',
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    beginMobileInputFloor: vi.fn().mockReturnValue({ commit: vi.fn(), rollback: vi.fn() }),
    isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(true),
    sendTerminalAgentPrompt: vi.fn(),
    sendTerminal
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.send reads only these runtime members.
  return { runtime: runtime as unknown as OrcaRuntimeService, sendTerminal, raw: runtime }
}

function request(params: Record<string, unknown>): RpcRequest {
  return {
    id: 'request',
    authToken: 'token',
    method: 'terminal.send',
    params: { terminal: 'terminal-1', text: 'hello', enter: true, ...params }
  }
}

describe('terminal.send chat input', () => {
  it('hands the action to the guarded writer and returns its agent-exited refusal', async () => {
    const refused = {
      handle: 'terminal-1',
      accepted: false,
      bytesWritten: 0,
      refusedReason: 'agent-exited'
    }
    const { runtime, sendTerminal } = makeRuntime(refused)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      request({ chatInput: { actionId: 'chat-1' }, client: { id: 'phone', type: 'mobile' } })
    )

    expect(sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      { text: 'hello', enter: true, interrupt: false },
      expect.objectContaining({ chatInput: { actionId: 'chat-1' } })
    )
    expect(response).toMatchObject({ ok: true, result: { send: refused } })
  })

  it('keeps a tagged desktop prompt off the settled-prompt path, whose writes are untagged', async () => {
    const { runtime, sendTerminal, raw } = makeRuntime({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 6
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    await dispatcher.dispatch(
      request({
        agentPrompt: true,
        chatInput: { actionId: 'chat-2' },
        client: { id: 'orca-desktop', type: 'desktop' }
      })
    )
    expect(raw.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(sendTerminal).toHaveBeenCalled()
  })

  it('rejects a malformed action id and passes no chat option for an untagged write', async () => {
    const { runtime, sendTerminal } = makeRuntime({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 6
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const bad = await dispatcher.dispatch(request({ chatInput: { actionId: 'x'.repeat(129) } }))
    expect(bad).toMatchObject({ ok: false })
    await dispatcher.dispatch(request({}))
    expect(sendTerminal.mock.calls.at(-1)?.[2]).not.toHaveProperty('chatInput')
  })
})
