import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import { TERMINAL_SEND_METHODS } from './terminal-send-method'

function request(text: string): RpcRequest {
  return {
    id: 'request-1',
    authToken: 'token',
    method: 'terminal.send',
    params: {
      terminal: 'term-1',
      text,
      enter: true,
      agentPrompt: true,
      client: { id: 'client-1', type: 'desktop' }
    }
  }
}

function runtimeStub() {
  const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
    handle: 'term-1',
    accepted: true,
    bytesWritten: 12
  })
  return {
    getRuntimeId: () => 'runtime-1',
    resolveLiveLeafForHandle: () => ({ ptyId: 'pty-1' }),
    getDriver: () => ({ kind: 'desktop' }),
    isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(true),
    sendTerminalAgentPrompt,
    sendTerminal: vi.fn()
  }
}

describe('terminal.send paired Web agent context', () => {
  it('passes authenticated Web surface to the semantic Agent prompt boundary', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: TERMINAL_SEND_METHODS
    })
    const replies: RpcResponse[] = []

    await dispatcher.dispatchStreaming(
      request('retry initialization'),
      (response) => replies.push(JSON.parse(response) as RpcResponse),
      {
        clientId: 'client-1',
        clientKind: 'runtime',
        clientCapabilities: ['client-surface.web.v1']
      }
    )

    expect(replies[0]).toMatchObject({ ok: true })
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term-1',
      'retry initialization',
      expect.objectContaining({ clientSurface: 'web' })
    )
  })

  it('keeps a Web prompt on the semantic path before Agent settlement is observed', async () => {
    const runtime = runtimeStub()
    runtime.isTerminalRunningSettledPromptAgent.mockResolvedValue(false)
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: TERMINAL_SEND_METHODS
    })

    await dispatcher.dispatchStreaming(request('first prompt after launch'), () => {}, {
      clientId: 'client-1',
      clientKind: 'runtime',
      clientCapabilities: ['client-surface.web.v1']
    })

    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term-1',
      'first prompt after launch',
      expect.objectContaining({ clientSurface: 'web' })
    )
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('keeps an in-process desktop prompt unchanged', async () => {
    const runtime = runtimeStub()
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: TERMINAL_SEND_METHODS
    })

    await dispatcher.dispatch(request('retry initialization'))

    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term-1',
      'retry initialization',
      expect.not.objectContaining({ clientSurface: 'web' })
    )
  })
})
