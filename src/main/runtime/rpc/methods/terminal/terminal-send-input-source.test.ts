import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_SEND_METHODS } from './terminal-send-method'
import { eraseRpcMethods, isStreamingMethod, type RpcMethod } from '../../core'

function makeRuntime(options: { settledPromptAgent?: boolean } = {}) {
  const write = async (_handle: string, _text: unknown, _options?: Record<string, unknown>) => ({
    accepted: true,
    bytesWritten: 3
  })
  const sendTerminal = vi.fn(write)
  const sendTerminalAgentPrompt = vi.fn(write)
  const runtime = {
    resolveLiveLeafForHandle: vi.fn(() => ({ ptyId: 'pty-1' })),
    getDriver: vi.fn(() => ({ kind: 'desktop' })),
    isTerminalRunningSettledPromptAgent: vi.fn(async () => options.settledPromptAgent === true),
    ensureStructuredAgentSessionHost: vi.fn(async () => null),
    sendTerminal,
    sendTerminalAgentPrompt
  }
  return { runtime, sendTerminal, sendTerminalAgentPrompt }
}

function sendMethod(): RpcMethod {
  const method = eraseRpcMethods(TERMINAL_SEND_METHODS).find(
    (m): m is RpcMethod => m.name === 'terminal.send' && !isStreamingMethod(m)
  )
  if (!method) {
    throw new Error('terminal.send is not registered')
  }
  return method
}

describe('terminal.send input source', () => {
  it('hands the RPC caller to the runtime write as its input source', async () => {
    const { runtime, sendTerminal } = makeRuntime()
    const method = sendMethod()

    await method.handler(method.params!.parse({ terminal: 'term-1', text: 'ls', enter: true }), {
      runtime,
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime'
    } as never)

    expect(sendTerminal).toHaveBeenCalledTimes(1)
    expect(sendTerminal.mock.calls[0]?.[2]).toMatchObject({
      inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
  })

  it('passes an empty source for an in-process caller so the runtime records it as local', async () => {
    const { runtime, sendTerminal } = makeRuntime()
    const method = sendMethod()

    await method.handler(method.params!.parse({ terminal: 'term-1', text: 'ls' }), {
      runtime
    } as never)

    expect(sendTerminal.mock.calls[0]?.[2]).toMatchObject({
      inputSource: { pairedDeviceId: undefined, clientKind: undefined }
    })
  })

  it('hands the caller to the settled agent-prompt path as well', async () => {
    const { runtime, sendTerminal, sendTerminalAgentPrompt } = makeRuntime({
      settledPromptAgent: true
    })
    const method = sendMethod()

    await method.handler(
      method.params!.parse({
        terminal: 'term-1',
        text: 'hello',
        enter: true,
        agentPrompt: true,
        client: { id: 'desktop-1', type: 'desktop' }
      }),
      { runtime, pairedDeviceId: 'device-laptop', clientKind: 'runtime' } as never
    )

    expect(sendTerminal).not.toHaveBeenCalled()
    expect(sendTerminalAgentPrompt.mock.calls[0]?.[2]).toMatchObject({
      inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
  })
})
